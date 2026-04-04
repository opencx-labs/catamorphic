import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  Node,
} from "ts-morph";
import type { ParameterInfo } from "./types.js";

type FunctionLike = FunctionDeclaration | FunctionExpression | ArrowFunction;

interface JsDocMetadata {
  displayName?: string;
  description?: string;
  icon?: string;
  tags: Record<string, string>;
  paramMetadata: Map<string, { displayName?: string; description?: string }>;
}

export function extractJsDocMetadata(fn: FunctionLike): JsDocMetadata {
  const result: JsDocMetadata = {
    tags: {},
    paramMetadata: new Map(),
  };

  const jsDocs =
    "getJsDocs" in fn ? (fn as FunctionDeclaration).getJsDocs() : [];

  for (const doc of jsDocs) {
    const desc = doc.getDescription().trim();
    if (desc) {
      result.description = desc;
    }

    let lastParamName: string | undefined;

    for (const tag of doc.getTags()) {
      const tagName = tag.getTagName();
      const tagText = tag.getCommentText()?.trim() ?? "";

      if (tagName === "param") {
        const compilerName = (
          tag.compilerNode as { name?: { getText(): string } }
        ).name?.getText();
        const nameMatch = tagText.match(/^(\w+)/);
        lastParamName = compilerName ?? nameMatch?.[1];
        parseParamTag(tagText, result.paramMetadata, lastParamName);
        result.tags[`param:${lastParamName ?? tagText.split(/\s/)[0]}`] =
          tagText;
      } else if (tagName === "displayname") {
        if (lastParamName) {
          const meta = result.paramMetadata.get(lastParamName) ?? {};
          meta.displayName = tagText.replace(/\s*\|?\s*$/, "").trim();
          result.paramMetadata.set(lastParamName, meta);
        } else {
          result.displayName = tagText;
        }
        result.tags.displayname = tagText;
      } else if (tagName === "description") {
        if (lastParamName) {
          const meta = result.paramMetadata.get(lastParamName) ?? {};
          meta.description = tagText.replace(/\s*\|?\s*$/, "").trim();
          result.paramMetadata.set(lastParamName, meta);
        } else if (!result.description) {
          result.description = tagText;
          result.tags.description = tagText;
        }
      } else if (tagName === "icon") {
        lastParamName = undefined;
        result.icon = tagText;
        result.tags.icon = tagText;
      } else {
        lastParamName = undefined;
        result.tags[tagName] = tagText;
      }
    }
  }

  return result;
}

function parseParamTag(
  text: string,
  map: Map<string, { displayName?: string; description?: string }>,
  explicitName?: string,
): void {
  const nameMatch = text.match(/^(\w+)/);
  const paramName = explicitName ?? nameMatch?.[1];
  if (!paramName) return;

  const rest = nameMatch
    ? text.slice(nameMatch[0].length).replace(/^\s*-\s*/, "")
    : text.replace(/^\s*-\s*/, "");

  const meta: { displayName?: string; description?: string } = {};

  const displayNameMatch = rest.match(/@displayname\s+([^|@]+)/i);
  if (displayNameMatch?.[1]) {
    meta.displayName = displayNameMatch[1].trim();
  }

  const descMatch = rest.match(/@description\s+([^|@]+)/i);
  if (descMatch?.[1]) {
    meta.description = descMatch[1].trim();
  }

  if (!meta.displayName && !meta.description) {
    meta.description = rest.trim() || undefined;
  }

  if (paramName) {
    map.set(paramName, meta);
  }
}

function extractDefaultValues(
  param: ReturnType<FunctionLike["getParameters"]>[number],
): Map<string, string> {
  const defaults = new Map<string, string>();
  const nameNode = param.getNameNode();
  if (!Node.isObjectBindingPattern(nameNode)) return defaults;

  for (const element of nameNode.getElements()) {
    const init = element.getInitializer();
    if (init) {
      defaults.set(element.getName(), init.getText());
    }
  }
  return defaults;
}

export function extractParameterInfo(
  fn: FunctionLike,
  paramMetadata: Map<string, { displayName?: string; description?: string }>,
): ParameterInfo[] {
  const params = fn.getParameters();
  const result: ParameterInfo[] = [];

  for (const param of params) {
    const typeNode = param.getTypeNode();

    if (param.isRestParameter()) continue;

    const defaults = extractDefaultValues(param);

    if (typeNode && typeNode.getKindName() === "TypeLiteral") {
      for (const member of typeNode.forEachChildAsArray()) {
        if (member.getKindName() === "PropertySignature") {
          const name = member.getChildAtIndex(0)?.getText() ?? "";
          const typeText = member.getChildAtIndex(2)?.getText() ?? "unknown";
          const isOptional = member.getText().includes("?");
          const meta = paramMetadata.get(name);

          result.push({
            name,
            type: typeText,
            optional: isOptional,
            displayName: meta?.displayName,
            description: meta?.description,
            defaultValue: defaults.get(name),
          });
        }
      }
    } else {
      const meta = paramMetadata.get(param.getName());
      result.push({
        name: param.getName(),
        type: param.getType().getText(),
        optional: param.isOptional(),
        displayName: meta?.displayName,
        description: meta?.description,
        defaultValue: param.getInitializer()?.getText(),
      });
    }
  }

  return result;
}
