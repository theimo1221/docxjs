import { WordDocument } from './word-document';
import {
    DomType,
    IDomTable,
    IDomNumbering,
    IDomHyperlink,
    IDomImage,
    OpenXmlElement,
    IDomTableColumn,
    IDomTableCell,
    TextElement,
    SymbolElement,
    BreakElement,
    FootnoteReferenceElement
} from './document/dom';
import { Length, CommonProperties } from './document/common';
import { Options } from './docx-preview';
import { DocumentElement } from './document/document';
import { ParagraphElement } from './document/paragraph';
import { appendClass, clone, keyBy, mergeDeep } from './utils';
import { updateDefaultTabStop, updateTabStop } from './javascript';
import { FontTablePart } from './font-table/font-table';
import { Section, SectionProperties, SectionRenderProperties } from './document/section';
import { RunElement, RunProperties } from './document/run';
import { BookmarkStartElement } from './document/bookmark';
import { IDomStyle } from './document/style';
import { Part } from './common/part';
import { HeaderPart } from './header/header-part';
import { FooterPart } from './footer/footer-part';
import { WmlFootnote } from './footnotes/footnote';
import { ThemePart } from './theme/theme-part';

interface CssChangeObject {
    cssRuleCamel: string;
    newVal: string;
}

interface noCssDictEntry {
    [cssRule: string]: CssChangeObject
}

export class HtmlRenderer {

    className: string = "docx";
    document: WordDocument;
    options: Options;
    noCssDict: { [selector: string]: noCssDictEntry } = {};
    styleMap: Record<string, IDomStyle> = {};

    footnoteMap: Record<string, WmlFootnote> = {};
    currentFootnoteIds: string[];

    constructor(public htmlDocument: Document) {
    }

    render(document: WordDocument, bodyContainer: HTMLElement, styleContainer: HTMLElement = null, options: Options) {
        this.document = document;
        this.options = options;
        this.className = options.className;
        this.styleMap = null;

        styleContainer = styleContainer || bodyContainer;
        if (options.noStyleBlock) {
            styleContainer = window.document.createElement("div");
        }

        removeAllElements(styleContainer);
        removeAllElements(bodyContainer);

        appendComment(styleContainer, "docxjs library predefined styles");
        styleContainer.appendChild(this.renderDefaultStyle());

        if (document.themePart) {
            appendComment(styleContainer, "docxjs document theme values");
            this.renderTheme(document.themePart, styleContainer);
        }

        if (document.stylesPart != null) {
            this.styleMap = this.processStyles(document.stylesPart.styles);

            appendComment(styleContainer, "docxjs document styles");
            styleContainer.appendChild(this.renderStyles(document.stylesPart.styles));
        }

        if (document.numberingPart) {
            this.prodessNumberings(document.numberingPart.domNumberings);

            appendComment(styleContainer, "docxjs document numbering styles");
            styleContainer.appendChild(this.renderNumbering(document.numberingPart.domNumberings, styleContainer));
            //styleContainer.appendChild(this.renderNumbering2(document.numberingPart, styleContainer));
        }

        if (document.footnotesPart) {
            this.footnoteMap = keyBy(document.footnotesPart.footnotes, x => x.id);
        }

        if (!options.ignoreFonts && document.fontTablePart) {
            this.renderFontTable(document.fontTablePart, styleContainer);
        }

        var sectionElements = this.renderSections(document.documentPart.body);

        if (this.options.inWrapper) {
            bodyContainer.appendChild(this.renderWrapper(sectionElements));
        }
        else {
            appendChildren(bodyContainer, sectionElements);
        }
        if (options.noStyleBlock) {
            this.applyCss(this.noCssDict, bodyContainer);
        }
    }

    renderTheme(themePart: ThemePart, styleContainer: HTMLElement) {
        const variables = {};
        const fontScheme = themePart.theme?.fontScheme;

        if (fontScheme) {
            if (fontScheme.majorFont) {
                variables['--docx-majorHAnsi-font'] = fontScheme.majorFont.latinTypeface;
            }

            if (fontScheme.minorFont) {
                variables['--docx-minorHAnsi-font'] = fontScheme.minorFont.latinTypeface;
            }
        }

        const colorScheme = themePart.theme?.colorScheme;

        if (colorScheme) {
            for (let [k, v] of Object.entries(colorScheme.colors)) {
                variables[`--docx-${k}-color`] = `#${v}`;
            }
        }

        const cssText = this.styleToString(`.${this.className}`, variables);
        styleContainer.appendChild(createStyleElement(cssText));
    }

    renderFontTable(fontsPart: FontTablePart, styleContainer: HTMLElement) {
        for (let f of fontsPart.fonts) {
            for (let ref of f.embedFontRefs) {
                this.document.loadFont(ref.id, ref.key).then(fontData => {
                    var cssValues = {
                        'font-family': f.name,
                        'src': `url(${fontData})`
                    };

                    if (ref.type == "bold" || ref.type == "boldItalic") {
                        cssValues['font-weight'] = 'bold';
                    }

                    if (ref.type == "italic" || ref.type == "boldItalic") {
                        cssValues['font-style'] = 'italic';
                    }

                    appendComment(styleContainer, `docxjs ${f.name} font`);
                    const cssText = this.styleToString("@font-face", cssValues);
                    styleContainer.appendChild(createStyleElement(cssText));
                });
            }
        }
    }

    processClassName(className: string) {
        if (!className)
            return this.className;

        return `${this.className}_${className}`;
    }

    processStyles(styles: IDomStyle[]): Record<string, IDomStyle> {
        var stylesMap: Record<string, IDomStyle> = {};

        for (let style of styles.filter(x => x.id != null)) {
            this.replaceAsciiTheme(style);
            style.basedOnResolved = !style.basedOn;
            stylesMap[style.id] = style;
        }
        for (let style of styles.filter(x => x.basedOn)) {
            if (style.basedOnResolved) {
                continue;
            }
            this.resolveBaseStyle(style, stylesMap)
        }

        for (let style of styles) {
            this.replaceAsciiTheme(style, true);
            style.cssName = this.processClassName(this.escapeClassName(style.id));
        }
        const defaultStyles = styles.filter(x => x.isDefault);
        const defaultOverride: IDomStyle = clone(defaultStyles[0]);
        defaultOverride.styles = [];
        for (let defaultStyle of defaultStyles) {
            this.copyStyle(defaultStyle, defaultOverride);
        }
        for (let style of styles.filter(x => x.id === null)) {
            this.copyStyle(defaultOverride, style, true);
        }
        return stylesMap;
    }

    prodessNumberings(numberings: IDomNumbering[]) {
        for (let num of numberings.filter(n => n.pStyleName)) {
            const style = this.styleMap[num.pStyleName];

            if (style.paragraphProps?.numbering) {
                style.paragraphProps.numbering.level = num.level;
            }
        }
    }

    processElement(element: OpenXmlElement) {
        if (element.children) {
            for (var e of element.children) {
                e.className = this.processClassName(e.className);
                e.parent = element;

                if (e.type == DomType.Table) {
                    this.processTable(e);
                }
                else {
                    this.processElement(e);
                }
            }
        }
    }

    processTable(table: IDomTable) {
        for (var r of table.children) {
            for (var c of r.children) {
                c.cssStyle = this.copyStyleProperties(table.cellStyle, c.cssStyle, [
                    "border-left", "border-right", "border-top", "border-bottom",
                    "padding-left", "padding-right", "padding-top", "padding-bottom"
                ]);

                this.processElement(c);
            }
        }
    }

    copyStyleProperties(
        input: Record<string, string>,
        output: Record<string, string>,
        attrs: string[] = null,
        overideExistingEntries: boolean = false
    ): Record<string, string> {
        if (!input)
            return output;

        if (output == null) output = {};
        if (attrs == null) attrs = Object.getOwnPropertyNames(input);

        for (var key of attrs) {
            if (input.hasOwnProperty(key) && (overideExistingEntries || !output.hasOwnProperty(key))) {
                output[key] = input[key];
            }
        }

        return output;
    }

    createSection(className: string, props: SectionProperties) {
        var elem = this.createElement("section", { className });

        if (!props) {
            return elem;
        }

        if (props.pageMargins) {
            elem.style.paddingLeft = this.renderLength(props.pageMargins.left);
            elem.style.paddingRight = this.renderLength(props.pageMargins.right);
            elem.style.paddingTop = this.renderLength(props.pageMargins.top);
            elem.style.paddingBottom = this.renderLength(props.pageMargins.bottom);
        }

        if (props.pageSize) {
            if (!this.options.ignoreWidth)
                elem.style.width = this.renderLength(props.pageSize.width);
            if (!this.options.ignoreHeight)
                elem.style.minHeight = this.renderLength(props.pageSize.height);
        }

        if (props.columns && props.columns.numberOfColumns) {
            elem.style.columnCount = `${props.columns.numberOfColumns}`;
            elem.style.columnGap = this.renderLength(props.columns.space);

            if (props.columns.separator) {
                elem.style.columnRule = "1px solid black";
            }
        }

        return elem;
    }

    renderSections(document: DocumentElement): HTMLElement[] {
        const result = [];

        this.processElement(document);

        for (let section of this.splitBySection(document.children, document.props)) {
            this.currentFootnoteIds = [];
            const sectProps = section.sectProps as SectionRenderProperties;
            const sectionElement = this.createSection(this.className, sectProps);
            this.renderStyleValues(document.cssStyle, sectionElement);

            if (this.options.renderHeaders) {
                const headerPart = this.findHeaderFooter<HeaderPart>(sectProps, false);
                if (headerPart && headerPart.headerElement) {
                    this.renderElements([headerPart.headerElement], sectionElement);
                }
            }

            var contentElement = this.createElement("article");
            this.renderElements(section.elements, contentElement);
            sectionElement.appendChild(contentElement);

            if (this.options.renderFootnotes) {
                this.renderFootnotes(this.currentFootnoteIds, sectionElement);
            }


            if (this.options.renderFooters) {
                const footerPart = this.findHeaderFooter<FooterPart>(sectProps, true);
                if (footerPart && footerPart.footerElement) {
                    this.renderElements([footerPart.footerElement], sectionElement);
                }
            }

            result.push(sectionElement);
        }

        return result;
    }

    findHeaderFooter<T extends Part>(sectProps: SectionRenderProperties, getFooter = true): T {
        const refs = getFooter ? sectProps.footerRefs : sectProps.headerRefs;
        const page: number = sectProps.pageWithinSection;
        const first = refs.find(x => x.type == "first") ?? null;
        const even = refs.find(x => x.type == "even") ?? null;
        const def = refs.find(x => x.type == "default") ?? null;
        let refToUse = null;
        if (sectProps.forceFirstFooterHeaderDifferent && page === 1) {
            refToUse = first;
        }
        else if (page === 1 && first) {
            refToUse = first;
        }
        else if (even && page % 2 === 0) {
            refToUse = even;
        }
        else {
            refToUse = def;
        }

        if (refToUse == null) {
            return null;
        }

        return this.document.findPartByRelId(refToUse.id, this.document.documentPart) as T;
    }

    isPageBreakElement(elem: OpenXmlElement): boolean {
        if (elem.type != DomType.Break)
            return false;

        if ((elem as BreakElement).break == "lastRenderedPageBreak")
            return !this.options.ignoreLastRenderedPageBreak;

        return (elem as BreakElement).break == "page";
    }

    splitBySection(elements: OpenXmlElement[], lastSectionProps: SectionProperties): Section[] {
        let current: Section = { sectProps: null, elements: [] };
        var result = [current];
        let sectProps: SectionProperties;

        for (let elem of elements) {
            if (elem.type == DomType.Paragraph) {
                const styleName = (elem as ParagraphElement).styleName;
                const s = this.styleMap && styleName ? this.styleMap[styleName] : null;

                if (s?.paragraphProps?.pageBreakBefore) {
                    current.sectProps = clone(sectProps);
                    current = { sectProps: null, elements: [] };
                    result.push(current);
                }
            }

            current.elements.push(elem);

            if (elem.type != DomType.Paragraph) {
                continue;
            }
            const p = elem as ParagraphElement;
            sectProps = clone(p.sectionProps);
            var pBreakIndex = -1;
            var rBreakIndex = -1;
            if (this.options.breakPages && p.children) {
                pBreakIndex = p.children.findIndex(r => {
                    rBreakIndex = r.children?.findIndex(this.isPageBreakElement.bind(this)) ?? -1;
                    return rBreakIndex != -1;
                });
                if (pBreakIndex > 0) {
                    // Include Bookmarks in breaking
                    while (pBreakIndex > 0 && p.children[pBreakIndex - 1].type === DomType.BookmarkStart) {
                        pBreakIndex--;
                    }
                }
            }
            if (sectProps || (pBreakIndex > -1 && pBreakIndex > (this.isFirstRenderElement(current.elements) ? 0 : -1))) {
                if (sectProps) {
                    current.sectProps = clone(sectProps);
                }
                current = { sectProps: null, elements: [] };
                if (pBreakIndex === 0) {
                    current.elements.push(elem);
                    result[result.length - 1].elements.pop();
                }
                result.push(current);
            }
            if (pBreakIndex <= 0 ||
                !p.children || p.children.length <= pBreakIndex
            ) {
                continue;
            }
            let breakRun = p.children[pBreakIndex];
            if (!breakRun || !breakRun.children) {
                continue;
            }
            let splitRun = rBreakIndex < breakRun.children.length - 1;
            if (!(pBreakIndex < p.children.length - 1 || splitRun)) {
                continue;
            }
            var children = elem.children;
            var newParagraph = { ...elem, children: children.slice(pBreakIndex) };
            elem.children = children.slice(0, pBreakIndex);
            current.elements.push(newParagraph);
            if (!splitRun) {
                continue;
            }
            let runChildren = breakRun.children;
            let newRun = { ...breakRun, children: runChildren.slice(0, rBreakIndex) };
            elem.children.push(newRun);
            breakRun.children = runChildren.slice(rBreakIndex);
        }


        if (result.length > 0) {
            // The last sections props are located in the body itself
            result[result.length - 1].sectProps = lastSectionProps;
        }

        let currentSectProps = null;
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i].sectProps === null) {
                result[i].sectProps = clone(currentSectProps);
            }
            else {
                currentSectProps = clone(result[i].sectProps);
            }
        }

        this.addSectionInnerPageNums(result);
        return result;
    }

    private addSectionInnerPageNums(result: Section[]) {
        // Add Section inner page Count to Sections
        let lastSectionId: string = "";
        let sectiontPageCount: number = 0;
        for (let j = 0; j < result.length; j++) {
            const sectProps = result[j].sectProps;
            if (sectProps === null) {
                continue;
            }
            if (sectProps.id !== lastSectionId) {
                lastSectionId = sectProps.id;
                sectiontPageCount = 1;
            }
            else {
                sectiontPageCount++;
            }
            (sectProps as SectionRenderProperties).pageWithinSection = sectiontPageCount;
        }
    }

    renderLength(l: Length): string {
        return l ? `${l.value.toFixed(2)}${l.type ?? ''}` : null;
    }

    renderWrapper(children: HTMLElement[]) {
        return this.createElement("div", { className: `${this.className}-wrapper` }, children);
    }

    renderDefaultStyle() {
        var c = this.className;
        var styleText = `.${c}-wrapper { background: gray; padding: 30px; padding-bottom: 0px; display: flex; flex-flow: column; align-items: center; } 
.${c}-wrapper>section.${c} { background: white; box-shadow: 0 0 10px rgba(0, 0, 0, 0.5); margin-bottom: 30px; }
.${c} { color: black; }
section.${c} { box-sizing: border-box; display: flex; flex-flow: column nowrap; position: relative; }
section.${c}>article { margin-bottom: auto; }
.${c} table { border-collapse: collapse; }
.${c} table td, .${c} table th { vertical-align: top; }
.${c} p { margin: 0pt; min-height: 1em; margin-block-start: 0; margin-block-end: 0; }
.${c} span { white-space: pre-wrap; }`;
        if (this.options.noStyleBlock) {
            this.noCssDict[`.${c}-wrapper`] = {
                "background": { cssRuleCamel: "background", newVal: "gray" },
                "padding": { cssRuleCamel: "padding", newVal: "30px" },
                "padding-bottom": { cssRuleCamel: "paddingBottom", newVal: "0px" },
                "display": { cssRuleCamel: "display", newVal: "flex" },
                "flex-flow": { cssRuleCamel: "flexFlow", newVal: "column" },
                "align-items": { cssRuleCamel: "alignItems", newVal: "center" }
            };
            this.noCssDict[`.${c}-wrapper>section.${c}`] = {
                "background": { cssRuleCamel: "background", newVal: "white" },
                "box-shadow": { cssRuleCamel: "boxShadow", newVal: "0 0 10px rgba(0, 0, 0, 0.5)" },
                "margin-bottom": { cssRuleCamel: "marginBottom", newVal: "30px" }
            };
            this.noCssDict[`.${c}`] = {
                "color": { cssRuleCamel: "color", newVal: "black" },
            };
            this.noCssDict[`section.${c}`] = {
                "box-sizing": { cssRuleCamel: "boxSizing", newVal: "border-box" },
                "display": { cssRuleCamel: "display", newVal: "flex" },
                "flex-flow": { cssRuleCamel: "flexFlow", newVal: "column nowrap" },
                "position": { cssRuleCamel: "position", newVal: "relative" },
            };
            this.noCssDict[`section.${c}>article`] = {
                "margin-bottom": { cssRuleCamel: "marginBottom", newVal: "auto" },
            };
            this.noCssDict[`.${c} table`] = {
                "border-collapse": { cssRuleCamel: "borderCollapse", newVal: "collapse" },
            };
            this.noCssDict[`.${c} table td`] = {
                "vertical-align": { cssRuleCamel: "verticalAlign", newVal: "top" },
            };
            this.noCssDict[`.${c} table th`] = {
                "vertical-align": { cssRuleCamel: "verticalAlign", newVal: "top" },
            };
            this.noCssDict[`.${c} p`] = {
                "margin": { cssRuleCamel: "margin", newVal: "0pt" },
                "margin-block-start": { cssRuleCamel: "marginBlockStart", newVal: "0" },
                "margin-block-end": { cssRuleCamel: "marginBlockEnd", newVal: "0" },
                "min-height": { cssRuleCamel: "minHeight", newVal: "1em" },
            };
            this.noCssDict[`.${c} span`] = {
                "white-space": { cssRuleCamel: "whiteSpace", newVal: "preWrap" },
            };
        }

        return createStyleElement(styleText);
    }

    // renderNumbering2(numberingPart: NumberingPartProperties, container: HTMLElement): HTMLElement {
    //     let css = "";
    //     const numberingMap = keyBy(numberingPart.abstractNumberings, x => x.id);
    //     const bulletMap = keyBy(numberingPart.bulletPictures, x => x.id);
    //     const topCounters = [];

    //     for(let num of numberingPart.numberings) {
    //         const absNum = numberingMap[num.abstractId];

    //         for(let lvl of absNum.levels) {
    //             const className = this.numberingClass(num.id, lvl.level);
    //             let listStyleType = "none";

    //             if(lvl.text && lvl.format == 'decimal') {
    //                 const counter = this.numberingCounter(num.id, lvl.level);

    //                 if (lvl.level > 0) {
    //                     css += this.styleToString(`p.${this.numberingClass(num.id, lvl.level - 1)}`, {
    //                         "counter-reset": counter
    //                     });
    //                 } else {
    //                     topCounters.push(counter);
    //                 }

    //                 css += this.styleToString(`p.${className}:before`, {
    //                     "content": this.levelTextToContent(lvl.text, num.id),
    //                     "counter-increment": counter
    //                 });
    //             } else if(lvl.bulletPictureId) {
    //                 let pict = bulletMap[lvl.bulletPictureId];
    //                 let variable = `--${this.className}-${pict.referenceId}`.toLowerCase();

    //                 css += this.styleToString(`p.${className}:before`, {
    //                     "content": "' '",
    //                     "display": "inline-block",
    //                     "background": `var(${variable})`
    //                 }, pict.style);

    //                 this.document.loadNumberingImage(pict.referenceId).then(data => {
    //                     var text = `.${this.className}-wrapper { ${variable}: url(${data}) }`;
    //                     container.appendChild(createStyleElement(text));
    //                 });
    //             } else {
    //                 listStyleType = this.numFormatToCssValue(lvl.format);
    //             }

    //             css += this.styleToString(`p.${className}`, {
    //                 "display": "list-item",
    //                 "list-style-position": "inside",
    //                 "list-style-type": listStyleType,
    //                 //TODO
    //                 //...num.style
    //             });
    //         }
    //     }

    //     if (topCounters.length > 0) {
    //         css += this.styleToString(`.${this.className}-wrapper`, {
    //             "counter-reset": topCounters.join(" ")
    //         });
    //     }

    //     return createStyleElement(css);
    // }

    renderNumbering(numberings: IDomNumbering[], styleContainer: HTMLElement) {
        var styleText = "";
        var rootCounters = [];

        for (var num of numberings) {
            var selector = `p.${this.numberingClass(num.id, num.level)}`;
            var listStyleType = "none";

            if (num.bullet) {
                let valiable = `--${this.className}-${num.bullet.src}`.toLowerCase();

                styleText += this.styleToString(`${selector}:before`, {
                    "content": "' '",
                    "display": "inline-block",
                    "background": `var(${valiable})`
                }, num.bullet.style);

                this.document.loadNumberingImage(num.bullet.src).then(data => {
                    var text = `.${this.className}-wrapper { ${valiable}: url(${data}) }`;
                    styleContainer.appendChild(createStyleElement(text));
                });
            }
            else if (num.levelText) {
                let counter = this.numberingCounter(num.id, num.level);

                if (num.level > 0) {
                    styleText += this.styleToString(`p.${this.numberingClass(num.id, num.level - 1)}`, {
                        "counter-reset": counter
                    });
                }
                else {
                    rootCounters.push(counter);
                }

                styleText += this.styleToString(`${selector}:before`, {
                    "content": this.levelTextToContent(num.levelText, num.suff, num.id, this.numFormatToCssValue(num.format)),
                    "counter-increment": counter,
                    ...num.rStyle,
                });
            }
            else {
                listStyleType = this.numFormatToCssValue(num.format);
            }

            styleText += this.styleToString(selector, {
                "display": "list-item",
                "list-style-position": "inside",
                "list-style-type": listStyleType,
                ...num.pStyle
            });
        }

        if (rootCounters.length > 0) {
            styleText += this.styleToString(`.${this.className}-wrapper`, {
                "counter-reset": rootCounters.join(" ")
            });
        }

        return createStyleElement(styleText);
    }

    renderStyles(styles: IDomStyle[]): HTMLElement {
        var styleText = "";
        var stylesMap = this.styleMap;
        var defautStyles = keyBy(styles.filter(s => s.isDefault), s => s.target);

        for (let style of styles) {
            var subStyles = style.styles;

            if (style.linked) {
                var linkedStyle = style.linked && stylesMap[style.linked];

                if (linkedStyle)
                    subStyles = subStyles.concat(linkedStyle.styles);
                else if (this.options.debug)
                    console.warn(`Can't find linked style ${style.linked}`);
            }

            for (var subStyle of subStyles) {
                var selector = "";

                if (style.target == subStyle.target)
                    selector += `${style.target}.${style.cssName}`;
                else if (style.target)
                    selector += `${style.target}.${style.cssName} ${subStyle.target}`;
                else
                    selector += `.${style.cssName} ${subStyle.target}`;

                if (defautStyles[style.target] == style)
                    selector = `.${this.className} ${style.target}, ` + selector;

                styleText += this.styleToString(selector, subStyle.values);
            }
        }

        return createStyleElement(styleText);
    }

    renderFootnotes(footnoteIds: string[], into: HTMLElement) {
        var footnotes = footnoteIds.map(id => this.footnoteMap[id]).filter(x => x);

        if (footnotes.length > 0) {
            var result = this.createElement("ol", null, this.renderElements(footnotes));
            into.appendChild(result);
        }
    }

    renderElement(elem: OpenXmlElement): Node {
        switch (elem.type) {
            case DomType.Paragraph:
                return this.renderParagraph(<ParagraphElement>elem);

            case DomType.BookmarkStart:
                return this.renderBookmarkStart(<BookmarkStartElement>elem);

            case DomType.BookmarkEnd:
                return null;

            case DomType.Run:
                return this.renderRun(<RunElement>elem);

            case DomType.Table:
                return this.renderTable(elem);

            case DomType.Row:
                return this.renderTableRow(elem);

            case DomType.Cell:
                return this.renderTableCell(elem);

            case DomType.Hyperlink:
                return this.renderHyperlink(elem);

            case DomType.Drawing:
                return this.renderDrawing(<IDomImage>elem);

            case DomType.Image:
                return this.renderImage(<IDomImage>elem);

            case DomType.Text:
                return this.renderText(<TextElement>elem);

            case DomType.Tab:
                return this.renderTab(elem);

            case DomType.Symbol:
                return this.renderSymbol(<SymbolElement>elem);

            case DomType.Break:
                return this.renderBreak(<BreakElement>elem);

            case DomType.Footer:
                return this.renderContainer(elem, "footer");

            case DomType.Header:
                return this.renderContainer(elem, "header");

            case DomType.Footnote:
                return this.renderContainer(elem, "li");

            case DomType.FootnoteReference:
                return this.renderFootnoteReference(elem as FootnoteReferenceElement);

            case DomType.NoBreakHyphen:
                return this.createElement("wbr");

            default:
                console.warn(`DomType ${elem.type} has no rendering implementation.`);
                return null;
        }

        return null;
    }

    renderChildren(elem: OpenXmlElement, into?: HTMLElement): Node[] {
        return this.renderElements(elem.children, into);
    }

    renderElements(elems: OpenXmlElement[], into?: HTMLElement): Node[] {
        if (elems == null)
            return null;

        var result = elems.map(e => this.renderElement(e)).filter(e => e != null);

        if (into)
            for (let c of result)
                into.appendChild(c);

        return result;
    }

    renderContainer(elem: OpenXmlElement, tagName: keyof HTMLElementTagNameMap) {
        return this.createElement(tagName, null, this.renderChildren(elem));
    }

    renderParagraph(elem: ParagraphElement) {
        var result = this.createElement("p");

        this.renderClass(elem, result);
        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        this.renderCommonProeprties(result.style, elem);

        const style = elem.styleName && this.styleMap[elem.styleName];
        const numbering = elem.numbering ?? style?.paragraphProps?.numbering;

        if (numbering) {
            var numberingClass = this.numberingClass(numbering.id, numbering.level);
            result.className = appendClass(result.className, numberingClass);
        }

        if (elem.styleName) {
            var styleClassName = this.processClassName(this.escapeClassName(elem.styleName));
            result.className = appendClass(result.className, styleClassName);
        }

        return result;
    }

    renderRunProperties(style: any, props: RunProperties) {
        this.renderCommonProeprties(style, props);
    }

    renderCommonProeprties(style: any, props: CommonProperties) {
        if (props == null)
            return;

        if (props.color) {
            style["color"] = props.color;
        }

        if (props.fontSize) {
            style["font-size"] = this.renderLength(props.fontSize);
        }
    }

    renderHyperlink(elem: IDomHyperlink) {
        var result = this.createElement("a");

        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        if (elem.href)
            result.href = elem.href

        return result;
    }

    renderDrawing(elem: IDomImage) {
        var result = this.createElement("div");

        result.style.display = "inline-block";
        result.style.position = "relative";
        result.style.textIndent = "0px";

        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        return result;
    }

    renderImage(elem: IDomImage) {
        let result = this.createElement("img");

        this.renderStyleValues(elem.cssStyle, result);

        if (this.document) {
            this.document.loadDocumentImage(elem.src).then(x => {
                result.src = x;
            });
        }

        return result;
    }

    renderText(elem: TextElement) {
        return this.htmlDocument.createTextNode(elem.text);
    }

    renderBreak(elem: BreakElement) {
        if (elem.break == "textWrapping") {
            return this.createElement("br");
        }

        return null;
    }

    renderSymbol(elem: SymbolElement) {
        var span = this.createElement("span");
        span.style.fontFamily = elem.font;
        span.innerHTML = `&#x${elem.char};`
        return span;
    }

    renderFootnoteReference(elem: FootnoteReferenceElement) {
        var result = this.createElement("sup");
        this.currentFootnoteIds.push(elem.id);
        result.textContent = `${this.currentFootnoteIds.length}`;
        return result;
    }

    renderTab(elem: OpenXmlElement) {
        var tabSpan = this.createElement("span");

        tabSpan.innerHTML = "&emsp;";//"&nbsp;";

        if (this.options.experimental) {
            setTimeout(() => {
                var paragraph = findParent<ParagraphElement>(elem, DomType.Paragraph);

                if (paragraph?.tabs == null) {
                    updateDefaultTabStop(tabSpan, this.document.settingsPart.settings.defaultTabStopWidth.value);
                    return;
                }

                paragraph.tabs.sort((a, b) => a.position.value - b.position.value);
                updateTabStop(tabSpan, paragraph.tabs);
            }, 1500);
        }

        return tabSpan;
    }

    renderBookmarkStart(elem: BookmarkStartElement): HTMLElement {
        var result = this.createElement("span");
        result.id = elem.name;
        return result;
    }

    renderRun(elem: RunElement) {
        if (elem.fldCharType || elem.instrText)
            return null;

        var result = this.createElement("span");

        if (elem.id)
            result.id = elem.id;

        this.renderClass(elem, result);
        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        if (elem.verticalAlign) {
            result.style.verticalAlign = elem.verticalAlign;
            result.style.fontSize ||= "small";
        }

        return result;
    }

    renderTable(elem: IDomTable) {
        let result = this.createElement("table");

        if (elem.columns)
            result.appendChild(this.renderTableColumns(elem.columns));

        this.renderClass(elem, result);
        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        return result;
    }

    renderTableColumns(columns: IDomTableColumn[]) {
        let result = this.createElement("colgroup");

        for (let col of columns) {
            let colElem = this.createElement("col");

            if (col.width)
                colElem.style.width = col.width;

            result.appendChild(colElem);
        }

        return result;
    }

    renderTableRow(elem: OpenXmlElement) {
        let result = this.createElement("tr");

        this.renderClass(elem, result);
        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        return result;
    }

    renderTableCell(elem: IDomTableCell) {
        let result = this.createElement("td");

        this.renderClass(elem, result);
        this.renderChildren(elem, result);
        this.renderStyleValues(elem.cssStyle, result);

        if (elem.span) result.colSpan = elem.span;

        return result;
    }

    renderStyleValues(style: Record<string, string>, ouput: HTMLElement) {
        if (style == null)
            return;

        for (let key in style) {
            if (style.hasOwnProperty(key)) {
                ouput.style[key] = style[key];
            }
        }
    }

    renderClass(input: OpenXmlElement, ouput: HTMLElement) {
        if (input.className)
            ouput.className = input.className;
    }

    numberingClass(id: string, lvl: number) {
        return `${this.className}-num-${id}-${lvl}`;
    }

    styleToString(selectors: string, values: Record<string, string>, cssText: string = null) {
        if (!this.options.noStyleBlock) {
            let result = selectors + " {\r\n";

            for (const key in values) {
                result += `  ${key}: ${values[key]};\r\n`;
            }

            if (cssText) {
                result += cssText;
            }

            return result + "}\r\n";
        }
        const selectorsplits = selectors.split(", ");
        for (let i = 0; i < selectorsplits.length; i++) {
            const split = selectorsplits[i];
            if (this.noCssDict[split] === undefined) {
                this.noCssDict[split] = {};
            }
            for (const key in values) {
                const camelVal = key.replace(/-([a-z])/g, function (m, w) {
                    return w.toUpperCase();
                });
                this.noCssDict[split][key] = { cssRuleCamel: camelVal, newVal: values[key] };
            }
        }
        return "";
    }

    numberingCounter(id: string, lvl: number) {
        return `${this.className}-num-${id}-${lvl}`;
    }

    levelTextToContent(text: string, suff: string, id: string, numformat: string) {
        const suffMap = {
            "tab": "\\9",
            "space": "\\a0",
        };

        var result = text.replace(/%\d*/g, s => {
            let lvl = parseInt(s.substring(1), 10) - 1;
            return `"counter(${this.numberingCounter(id, lvl)}, ${numformat})"`;
        });

        return `"${result}${suffMap[suff] ?? ""}"`;
    }

    numFormatToCssValue(format: string) {
        var mapping = {
            "none": "none",
            "bullet": "disc",
            "decimal": "decimal",
            "lowerLetter": "lower-alpha",
            "upperLetter": "upper-alpha",
            "lowerRoman": "lower-roman",
            "upperRoman": "upper-roman",
        };

        return mapping[format] || format;
    }

    escapeClassName(className: string) {
        return className?.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and');
    }

    applyCss(dict: { [selector: string]: noCssDictEntry }, cont: HTMLElement) {
        let changeList: Array<{ selector: string, count: number, styles: noCssDictEntry }> =
            [];
        for (let selector in dict) {
            changeList.push({
                selector: selector,
                count: cont.querySelectorAll(selector).length,
                styles: dict[selector]
            });
        }
        changeList = changeList.sort((a, b) => {
            return a.count - b.count
        });
        for (let i = 0; i < changeList.length; i++) {
            const elements = cont.querySelectorAll(changeList[i].selector);
            for (let j = 0; j < elements.length; j++) {
                const element: HTMLElement = elements[j] as HTMLElement;
                const styles: string = element.getAttribute("style");
                const hasStyles: boolean = styles !== null;
                for (let style in changeList[i].styles) {
                    if (!hasStyles || styles.indexOf(style) === -1) {
                        const changeEntry = changeList[i].styles[style];
                        element.style[changeEntry.cssRuleCamel] = changeEntry.newVal;
                    }
                }
            }
        }
    }

    private resolveBaseStyle(style: IDomStyle, stylesMap: Record<string, IDomStyle>) {
        let baseStyle = stylesMap[style.basedOn];

        if (!baseStyle) {
            if (this.options.debug)
                console.warn(`Can't find base style ${style.basedOn}`);
            return;
        }

        if (baseStyle.basedOnResolved !== true) {
            // If the base is not resolved yet, resolve that one first
            this.resolveBaseStyle(baseStyle, stylesMap);
            baseStyle = stylesMap[style.basedOn];
        }
        this.copyStyle(baseStyle, style);
        style.basedOnResolved = true;
        stylesMap[style.id] = style;
    }

    private copyStyle(base: IDomStyle, target: IDomStyle, overideExistingEntries: boolean = false) {
        for (let baseStyleStyles of base.styles) {
            let styleStyleValues = target.styles.filter(x => x.target == baseStyleStyles.target);
            if (styleStyleValues && styleStyleValues.length > 0) {
                styleStyleValues[0].values = this.copyStyleProperties(
                    baseStyleStyles.values, styleStyleValues[0].values, null, overideExistingEntries
                );
            }
            else {
                target.styles.push(clone(baseStyleStyles))
            }
        }
    }

    private replaceAsciiTheme(style: IDomStyle, addDefault: boolean = false) {
        const themePart = this.document.themePart;
        const translatedFonts = themePart.theme.fontScheme;
        const minorLatinFont = translatedFonts.minorFont.latinTypeface;
        const hasMinorLatin = minorLatinFont !== "" && minorLatinFont !== undefined
        for (let j = 0; j < style.styles.length; j++) {
            const substyle = style.styles[j];
            const value = substyle.values["asciiTheme"];
            const hasFontFamily = substyle.values["font-family"] !== undefined;
            if (!value) {
                if (addDefault && !hasFontFamily && hasMinorLatin) {
                    substyle.values["font-family"] = minorLatinFont
                }
                continue;
            }
            delete substyle.values["asciiTheme"];
            if (hasFontFamily) {
                continue;
            }
            if (value === "minorHAnsi" && minorLatinFont) {
                substyle.values["font-family"] = minorLatinFont;
            }
            else if (value === "majorHAnsi" && translatedFonts.majorFont?.latinTypeface) {
                substyle.values["font-family"] = translatedFonts.majorFont.latinTypeface;
            }
        }
    }

    private isFirstRenderElement(elements: OpenXmlElement[]) {
        if (elements.length === 1) {
            return true;
        }
        for (let i = elements.length - 2; i >= 0; i--) {
            const element = elements[i];
            if (!element.children || element.children.length === 0) {
                continue;
            }
            for (let j = element.children.length - 1; j >= 0; j--) {
                const run = element.children[j];
                if (run.type !== DomType.Run || !run.children || run.children.length === 0) {
                    continue;
                }
                for (let k = run.children.length - 1; k >= 0; k--) {
                    const child = run.children[k];
                    if (child.type === DomType.BookmarkStart || child.type === DomType.BookmarkEnd || child.type === DomType.Break) {
                        continue;
                    }
                    return false;
                }
            }
        }
        return true;
    }


    createElement = createElement;
}

function createElement<T extends keyof HTMLElementTagNameMap>(
    tagName: T,
    props: Partial<Record<keyof HTMLElementTagNameMap[T], any>> = undefined,
    children: Node[] = undefined
): HTMLElementTagNameMap[T] {
    var result = Object.assign(document.createElement(tagName), props);
    children && appendChildren(result, children);
    return result;
}

function removeAllElements(elem: HTMLElement) {
    elem.innerHTML = '';
}

function appendChildren(elem: HTMLElement, children: Node[]) {
    children.forEach(c => elem.appendChild(c));
}

function createStyleElement(cssText: string) {
    return createElement("style", { innerHTML: cssText });
}

function appendComment(elem: HTMLElement, comment: string) {
    elem.appendChild(document.createComment(comment));
}

function findParent<T extends OpenXmlElement>(elem: OpenXmlElement, type: DomType): T {
    var parent = elem.parent;

    while (parent != null && parent.type != type)
        parent = parent.parent;

    return <T>parent;
}