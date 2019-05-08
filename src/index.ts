import path from "path";
import { getBrowser } from "./browser";
import { serializeCSSRules, deepMergeRules } from "css-sniff";
import jsxtojson from "jsx2json";
import {
  formatById,
  isString,
  getTemplateCSSRules,
  AnyObject,
  OnElement,
  OnCloseElement,
  OnText,
  OnVariable,
  OnSerialize,
  OnIf,
  OnCloseIf
} from "./common";
import {
  TemplateAttributesArgs,
  getTemplateAttributes,
  NodeGetAttribute
} from "./attributes";

const defaultFormats: string[] = Object.keys(formatById).filter(
  id => formatById[id].isDefaultOption
);

type Options = {
  async: boolean; // `true` seems good in Puppeteer but not tested properly in JSDOM
  dom: "jsdom" | "puppeteer";
  log: boolean;
};

const DEFAULT_OPTIONS: Options = {
  async: true,
  dom: "jsdom",
  log: false
};

export type Response = {
  metaTemplates: TemplateOutput[];
  disposeAll: Function;
};

export async function makeTemplates(
  template: TemplateInput,
  formatIds: string[] = defaultFormats,
  options?: Options | undefined
): Promise<Response> {
  const opts: Options = { ...DEFAULT_OPTIONS, ...options };
  if (opts.log) {
    console.info(
      `MetaTemplate: Using "${opts.dom}" for DOM with async:${
        opts.async
      } and these template(s) ${formatIds}`
    );
  }

  // Start a browser environment
  let browser = await getBrowser({ template }, { type: opts.dom });

  const metaTemplates: TemplateOutput[] = await jobType(
    template,
    formatIds,
    browser.bodyNodes,
    opts
  );

  browser.dispose();

  if (opts.log) {
    console.log("\n\n");
    metaTemplates.forEach(mt => {
      Object.keys(mt.files).forEach(mtPath => {
        console.log(mtPath, "\n===========", "\n" + mt.files[mtPath], "\n");
      });
    });
  }

  return {
    metaTemplates,
    disposeAll: browser.disposeAll
  };
}

async function jobType(
  template: TemplateInput,
  formatIds: string[],
  bodyNodes: Node[],
  options: Options
): Promise<TemplateOutput[]> {
  if (options.async) {
    return await Promise.all(
      formatIds.map(formatId =>
        generateFormat({ template, formatId, bodyNodes })
      )
    );
  } else {
    const result = [];
    for (let i = 0; i < formatIds.length; i++) {
      const formatId = formatIds[i];
      if (options.log) {
        console.info(`MetaTemplate: Generating ${formatId}`);
      }
      const format: TemplateOutput = await generateFormat({
        template,
        formatId,
        bodyNodes
      });
      result.push(format);
    }
    return result;
  }
}

type GenerateFormatArgs = {
  template: TemplateInput;
  formatId: string;
  bodyNodes: Node[];
};

export async function generateFormat({
  template,
  formatId,
  bodyNodes
}: GenerateFormatArgs): Promise<TemplateOutput> {
  const templateFormat = formatById[formatId];
  if (!templateFormat) {
    throw Error(
      `Unrecognised templateFormat "${formatId}". Valid options are ${Object.keys(
        formatById
      ).join(", ")}.`
    );
  }
  const format: any = new templateFormat(template);

  let allCssRules: AnyObject = {};

  for (let i = 0; i < bodyNodes.length; i++) {
    let childNode: Node = bodyNodes[i];
    const walkArgs: WalkArgs = {
      node: childNode,
      format,
      template,
      allCssRules
    };
    const { cssRules }: WalkResponse = await walk(walkArgs);
    allCssRules = deepMergeRules([allCssRules, cssRules]);
  }

  const cssString: string = serializeCSSRules(allCssRules);

  const hasMultipleRootNodes: boolean =
    bodyNodes.filter(childNode => childNode.nodeType === 1).length > 1;
  const serializeArgs: OnSerialize = {
    css: cssString,
    hasMultipleRootNodes
  };
  const files = await format.serialize(serializeArgs);

  const metaTemplate: TemplateOutput = {
    formatId,
    files
  };

  return metaTemplate;
}

const walk = async (walkArgs: WalkArgs): Promise<WalkResponse> => {
  const { node, format, template, allCssRules } = walkArgs;
  let newAllCssRules: AnyObject = allCssRules;
  let elementCssRules: AnyObject;
  switch (node.nodeType) {
    case 1: {
      // Element Node type
      const tagName = (node as HTMLElement).tagName.toLowerCase();
      if (tagName === "mt-variable") {
        const key: string = await NodeGetAttribute(node, "key");
        const defaultValue = (node as HTMLElement).innerHTML;
        const variableArgs: OnVariable = {
          key: format.registerDynamicKey(key, "node", true),
          defaultValue
        };
        format.onVariable(variableArgs);
      } else {
        let closingTagName = tagName;
        const isSelfClosing = !node.childNodes.length;
        if (tagName === "mt-if") {
          let key: string = await NodeGetAttribute(node, "key");
          const stableKey: boolean = key.includes("!");
          key = key.replace("!", ""); // will only replace one, but there should only be one
          let safeKey = key;
          const assignedKeys = format.getAssignedDynamicKeys();
          if (!stableKey || !assignedKeys.includes(key)) {
            safeKey = format.registerDynamicKey(key, "node", true);
          }
          const ifArgs: OnIf = {
            key: safeKey
          };
          if (format.onIf) {
            format.onIf(ifArgs);
          }
        } else {
          const templateArgs: TemplateAttributesArgs = {
            template,
            format,
            node: node as Element
          };
          const attributes = await getTemplateAttributes(templateArgs);

          elementCssRules = await getTemplateCSSRules(
            node,
            attributes,
            template
          );
          newAllCssRules = deepMergeRules([newAllCssRules, elementCssRules]);

          const args: OnElement = {
            tagName,
            attributes,
            isSelfClosing,
            css: serializeCSSRules(elementCssRules)
          };

          // get the closing tag name because it can change
          // when using (eg) Styled-Components
          closingTagName = await format.onElement(args);
        }
        if (!isSelfClosing) {
          const childNodes: Element[] = <Element[]>Array.from(node.childNodes);
          for (let i = 0; i < childNodes.length; i++) {
            const childNode = childNodes[i];
            const childWalkArgs: WalkArgs = {
              format: walkArgs.format,
              node: childNode,
              template,
              allCssRules: newAllCssRules
            };
            const { cssRules: childCssRules }: WalkResponse = await walk(
              childWalkArgs
            );

            newAllCssRules = deepMergeRules([newAllCssRules, childCssRules]);
          }
          if (tagName === "mt-if") {
            if (format.onCloseIf) {
              const closeArgs: OnCloseIf = {};
              await format.onCloseIf(closeArgs);
            }
          } else {
            const closeArgs: OnCloseElement = { tagName: closingTagName };
            await format.onCloseElement(closeArgs);
          }
        }
      }
      break;
    }
    case 3: {
      // Text Node type
      const args: OnText = {
        text: node.nodeValue
      };
      await format.onText(args);
      break;
    }
  }
  return { cssRules: newAllCssRules };
};

export const makeIndexImports = ({
  fileKeys,
  cssVariables
}: MakeIndexImports): Object => {
  // Generate an index file for JavaScript projects
  // that allows importing all files
  const byDir = fileKeys.reduce((byDir, key) => {
    const dirname = path.dirname(key);
    if (!byDir[dirname]) byDir[dirname] = [];
    byDir[dirname].push(key);
    return byDir;
  }, {});
  return Object.keys(byDir).reduce((byDirFiles, byDirKey) => {
    const templateGeneratorClass: any = formatById[byDirKey];
    let index = {};
    if (templateGeneratorClass) {
      const template: TemplateInput = {
        ...emptyTemplate,
        cssVariables
      };
      const templateGenerator = new formatById[byDirKey](template);
      index = templateGenerator.generateIndex(byDir[byDirKey]);
    } else {
      console.info(
        `No generateIndex found for "${byDirKey}" in ${Object.keys(formatById)}`
      );
    }
    return {
      ...byDirFiles,
      ...index
    };
  }, {});
};

export const emptyTemplate: TemplateInput = {
  id: "",
  html: "",
  css: ""
};

export const makeUsage = async (
  code: TemplateUsages,
  templates: TemplatesById,
  formatIds: string[] = defaultFormats
): Promise<FormatUsageExamples> => {
  const usages: string[] = await Promise.all(
    formatIds.map(async formatId => {
      const format: any = new formatById[formatId](emptyTemplate);
      if (format.makeUsage) {
        const usageResponse: FormatUsageResponse = await format.makeUsage(
          code,
          templates
        );
        return usageResponse.code;
      }
      return "";
    })
  );

  return formatIds.reduce((acc, formatId, index) => {
    acc[formatId] = usages[index];
    return acc;
  }, {});
};

export const jsxToUsageCode = async (jsx: string): Promise<TemplateUsages> => {
  const entry = (jsx: string) => {
    const document = jsxtojson(jsx, { useEval: false });

    const supportJSXProps = props => {
      // Working around a bug in jsx2json
      // https://github.com/stolksdorf/jsx2json/issues/2
      const keys = Object.keys(props);
      const newProps = {};
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        let value = props[key];
        if (
          typeof value === "string" &&
          value.startsWith("<") &&
          value.endsWith(">")
        ) {
          // Not a good check, but nothing is when we have to turn
          // a string into JSX and this seems to work.
          newProps[key] = entry(value);
        } else {
          newProps[key] = value;
        }
      }
      return newProps;
    };

    const walk = (node): TemplateUsage | string => {
      const allChildrenIsText =
        node.children && node.children.every(element => isString(element));

      if (isString(node)) {
        return node.trim();
      } else {
        const templateUsage: TemplateUsage = {
          templateId: node.type,
          variables: {
            ...(node.props ? supportJSXProps(node.props) : {}),
            ...(node.children && node.children.length > 0
              ? {
                  children: allChildrenIsText
                    ? node.children.join("").trim()
                    : node.children.map(walk)
                }
              : {})
          }
        };
        return templateUsage;
      }
    };

    const docArray = Array.isArray(document) ? document : [document];
    const templateUsages: TemplateUsages = docArray.map(walk);
    return templateUsages;
  };

  const jsObj = entry(jsx);
  return jsObj;
};

export const PRETTIER_LINE_WIDTH = 80;

export type TemplateUsage = TemplateUsageElement | string;

export type TemplateUsageElement = {
  templateId: string;
  variables: {
    [variableName: string]: TemplateUsage[] | string | boolean;
  };
};

export type TemplateUsages = TemplateUsage[];

export type TemplatesById = {
  [id: string]: TemplateInput;
};

export interface TemplateGenerator {} // FIXME

// List copied from https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Input
// Using Object to derive TS https://stackoverflow.com/a/49529930
const inputTypesObj = {
  button: null,
  checkbox: null,
  image: null,
  radio: null,
  color: null,
  date: null,
  datetime: null,
  "datetime-local": null,
  email: null,
  file: null,
  hidden: null,
  month: null,
  number: null,
  password: null,
  range: null,
  reset: null,
  search: null,
  submit: null,
  tel: null,
  text: null,
  url: null,
  week: null
};

export type TemplateInput = {
  id: string;
  html: string | undefined;
  css: string | undefined;
  cssVariables?: CSSVariablePattern[];
};

export type CSSVariablePattern = {
  id: string;
  defaultValue: string;
  nameMatch?: string;
  valueMatch?: string;
  valueSubstringMatch?: string;
};

export type TemplateOutput = {
  formatId: string;
  files: Object; // filename: data
};

type WalkArgs = {
  node: Node;
  format: any;
  template: TemplateInput;
  allCssRules: AnyObject;
};

type WalkResponse = {
  cssRules: AnyObject;
};

export type MakeIndexImports = {
  fileKeys: string[];
  cssVariables?: CSSVariablePattern[] | undefined;
};

export type FormatUsageExamples = { [key: string]: string };

export type FormatUsageResponse = {
  code: string;
  imports?: string[] | undefined;
};

export type FormatUsageOptions = {
  flattenAttributeValues?: boolean | undefined;
  tagNameReplacer?: Function | undefined;
  renderImport?: Function | undefined;
  importPrefix?: string | undefined; // TODO: Make this a required arg
};
