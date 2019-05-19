import { TemplateInput, emptyTemplate } from "../../index";
import {
  TemplateAttribute,
  simpleUniqueKey,
  OnElement,
  OnCloseElement,
  OnVariable,
  OnText,
  OnSerialize,
  EnumOption
} from "../../common";

export default class SilverStripeComponents {
  static id = "silverstripe-components";
  public dirname = "silverstripe-components";
  static isDefaultOption = true;

  data: string = "";
  template: TemplateInput;
  assignedDynamicKeys: string[];
  unescapedKeys: string[];

  constructor(template: TemplateInput = emptyTemplate) {
    this.template = template;
    this.data = "";
    this.assignedDynamicKeys = [];
    this.unescapedKeys = [];
  }

  wrapVar = (key: string): string => {
    // Seems safer to escape all vars using {$Var} rather than $Var.
    // see https://docs.silverstripe.org/en/4/developer_guides/templates/syntax/#escaping
    return `{$${key}}`;
  };

  ifVar = (
    needsPrecedingSpace: boolean,
    key: string,
    children: string,
    attribute: TemplateAttribute
  ): string => {
    return `<% if $${key} %>${needsPrecedingSpace ? " " : ""}${children ||
      attribute.key}<% end_if %>`;
  };

  renderAttribute = (attribute: TemplateAttribute, id: string): string => {
    // TODO: escape attribute values and keys?

    let attr = "";
    if (attribute.isOmittedIfEmpty) {
      attr += `<% if ${attribute.dynamicKeys
        .map(dynamicKey => `$${dynamicKey.key}`)
        .join(" && ")} %>`;
    }
    attr += ` ${attribute.key}="${attribute.value}`;

    if (attribute.dynamicKeys) {
      attr += (
        " " +
        attribute.dynamicKeys
          .map(dynamicKey => {
            switch (dynamicKey.type) {
              case "boolean": {
                return this.ifVar(
                  !!attribute.value || attribute.dynamicKeys.length > 1,
                  dynamicKey.key,
                  dynamicKey.ifTrueValue,
                  attribute
                );
                break;
              }
              case "string": {
                return this.wrapVar(dynamicKey.key);
                break;
              }
              default: {
                if (Array.isArray(dynamicKey.type)) {
                  return (
                    (dynamicKey.type as EnumOption[])
                      .map((enumOption, i) => {
                        let response = "";
                        if (i === 0) {
                          response += "<% if ";
                        } else {
                          response += "<% else_if ";
                        }
                        response += `$${dynamicKey.key} == "${
                          enumOption.name
                        }" %>${enumOption.value}`;
                        return response;
                      })
                      .join("") + "<% end_if %>"
                  );
                }
                break;
              }
            }
          })
          .join(" ")
      ).trim();
    } else {
      attr += attribute.value;
    }
    attr += `"`;
    if (attribute.isOmittedIfEmpty) {
      attr += "<% end_if %>";
    }
    return attr;
  };

  onElement = async ({
    tagName,
    attributes,
    isSelfClosing
  }: OnElement): Promise<string> => {
    this.data +=
      `<${tagName}` + // TODO: escape elementName?
      (attributes
        ? attributes
            .map((attribute: TemplateAttribute) => {
              return this.renderAttribute(attribute, this.template.id);
            })
            .join("")
        : "") +
      (isSelfClosing ? "/" : "") +
      "> "; // DEV NOTE: trailing whitespace to help Prettier linewrap
    return tagName;
  };

  onCloseElement = async ({ tagName }: OnCloseElement): Promise<void> => {
    this.data += `</${tagName}> `; // DEV NOTE: trailing whitespace to help Prettier linewrap
  };

  onText = async ({ text }: OnText): Promise<void> => {
    this.data += text;
  };

  onVariable = async ({ key }: OnVariable): Promise<void> => {
    this.data += this.wrapVar(key) + "\n";
  };

  escapeWarning = (): string => {
    return `{{! DEVELOPER NOTE: This template uses triple-bracket "{{{"\n    which disables HTML escaping.\n    Please ensure these variables are properly escaped:\n     - ${this.unescapedKeys.join(
      ",\n     - "
    )}.\n    The reason for this is to allow raw HTML, for values such as (eg) '<span lang="mi">Māori</span>'. }}\n\n`;
  };

  serialize = async ({ css }: OnSerialize): Promise<Object> => {
    const warning = this.unescapedKeys.length ? this.escapeWarning() : "";
    const extname = "ss";

    const files = {
      [`${this.dirname}/${this.template.id}.${extname}`]: `${warning}${
        this.data
      }`.trim()
    };

    return files;
  };

  registerDynamicKey = (key: string): string => {
    return simpleUniqueKey(key, this.assignedDynamicKeys);
  };

  getAssignedDynamicKeys = (): string[] => {
    return this.assignedDynamicKeys;
  };

  generateIndex = (filesArr: string[]): Object => {
    return {};
  };
}
