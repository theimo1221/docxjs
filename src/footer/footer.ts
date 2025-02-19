import { DomType, OpenXmlElement } from "../document/dom";

export class WmlFooter implements OpenXmlElement {
    id?: string = "";
    type: DomType = DomType.Footer;
    children?: OpenXmlElement[] = [];
    cssStyle?: Record<string, string> = {};
    className?: string;
    parent?: OpenXmlElement;
}