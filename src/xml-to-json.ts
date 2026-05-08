/**
 * Minimal XML → JSON converter for legacy XML-RPC-style APIs (Namecheap,
 * Akismet, etc.) that the executor would otherwise hand back as raw text
 * blobs that agents can't reason about.
 *
 * Scope (deliberately small — no DOCTYPE, no namespaces awareness beyond
 * stripping prefixes, no schema):
 *   - Element nesting → nested objects
 *   - Repeated sibling elements with the same name → array
 *   - Attributes → "@attr" keys on the element
 *   - Text content → "#text" key when the element also has children/attrs,
 *     otherwise the element value is the text directly
 *   - CDATA sections → unwrapped text
 *   - XML processing instructions and comments → ignored
 *
 * If parsing fails (malformed XML, unexpected tokens), returns null and
 * lets the caller fall back to the raw string. Never throws.
 */
export function xmlToJson(xml: string): unknown | null {
  try {
    let i = 0;
    const len = xml.length;

    skipProlog();
    skipWhitespaceAndComments();
    if (i >= len) return null;
    if (xml[i] !== "<") return null;
    return parseElement();

    function skipProlog() {
      // <?xml ... ?>
      while (i < len) {
        skipWhitespace();
        if (xml.startsWith("<? ", i)) {
          const end = xml.indexOf("?>", i);
          if (end === -1) {
            i = len;
            return;
          }
          i = end + 2;
        } else if (xml.startsWith("<!--", i)) {
          const end = xml.indexOf("-->", i);
          if (end === -1) {
            i = len;
            return;
          }
          i = end + 3;
        } else if (xml.startsWith("<!DOCTYPE", i) || xml.startsWith("<!doctype", i)) {
          // Skip to matching > (handle nested [] for internal subset).
          let depth = 0;
          while (i < len) {
            if (xml[i] === "[") depth++;
            else if (xml[i] === "]") depth--;
            else if (xml[i] === ">" && depth === 0) {
              i++;
              break;
            }
            i++;
          }
        } else {
          break;
        }
      }
    }

    function skipWhitespaceAndComments() {
      while (i < len) {
        skipWhitespace();
        if (xml.startsWith("<!--", i)) {
          const end = xml.indexOf("-->", i);
          if (end === -1) {
            i = len;
            return;
          }
          i = end + 3;
        } else {
          break;
        }
      }
    }

    function skipWhitespace() {
      while (i < len) {
        const c = xml.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else break;
      }
    }

    function parseElement(): Record<string, unknown> | unknown {
      // Caller has positioned us at "<"
      i++; // consume <
      const nameStart = i;
      while (i < len && !/[\s\/>]/.test(xml[i])) i++;
      const rawName = xml.slice(nameStart, i);
      const name = stripNs(rawName);

      const attrs: Record<string, string> = {};
      while (i < len) {
        skipWhitespace();
        if (xml[i] === "/" || xml[i] === ">") break;
        // Read attribute name=value
        const aNameStart = i;
        while (i < len && xml[i] !== "= " && !/\s/.test(xml[i]) && xml[i] !== ">" && xml[i] !== "/") i++;
        const attrName = stripNs(xml.slice(aNameStart, i));
        skipWhitespace();
        if (xml[i] !== "= ") {
          // Boolean attribute (rare in our targets) — treat as empty.
          attrs[attrName] = "";
          continue;
        }
        i++; // consume =
        skipWhitespace();
        const quote = xml[i];
        if (quote !== '"' && quote !== "'") return null;
        i++;
        const valStart = i;
        while (i < len && xml[i] !== quote) i++;
        attrs[attrName] = decodeEntities(xml.slice(valStart, i));
        if (i < len) i++; // consume closing quote
      }

      // Self-closing
      if (xml[i] === "/") {
        i++;
        if (xml[i] !== ">") return null;
        i++;
        return Object.keys(attrs).length === 0
          ? { _name: name }
          : { _name: name, ...prefixAttrs(attrs) };
      }
      if (xml[i] !== ">") return null;
      i++;

      // Parse children + text
      const children: Record<string, unknown[]> = {};
      const childOrder: string[] = [];
      let text = "";
      while (i < len) {
        if (xml.startsWith("<!--", i)) {
          const end = xml.indexOf("-->", i);
          if (end === -1) return null;
          i = end + 3;
          continue;
        }
        if (xml.startsWith("<![CDATA[", i)) {
          const end = xml.indexOf("]]>", i);
          if (end === -1) return null;
          text += xml.slice(i + 9, end);
          i = end + 3;
          continue;
        }
        if (xml.startsWith("</", i)) {
          // End tag
          i += 2;
          const closeStart = i;
          while (i < len && xml[i] !== ">") i++;
          const closeName = stripNs(xml.slice(closeStart, i).trim());
          if (closeName !== name) return null;
          i++; // consume >
          break;
        }
        if (xml[i] === "<") {
          const child = parseElement();
          if (child === null) return null;
          const childName =
            typeof child === "object" && child !== null && "_name" in (child as object)
              ? ((child as Record<string, unknown>)._name as string)
              : "_unknown";
          const cleaned = cleanChild(child);
          if (!children[childName]) {
            children[childName] = [];
            childOrder.push(childName);
          }
          children[childName].push(cleaned);
          continue;
        }
        // Text node
        const tStart = i;
        while (i < len && xml[i] !== "<") i++;
        text += xml.slice(tStart, i);
      }

      const trimmedText = decodeEntities(text).trim();
      const hasChildren = childOrder.length > 0;
      const hasAttrs = Object.keys(attrs).length > 0;

      if (!hasChildren && !hasAttrs) {
        return { _name: name, _value: trimmedText };
      }
      const out: Record<string, unknown> = { _name: name };
      if (hasAttrs) Object.assign(out, prefixAttrs(attrs));
      for (const cn of childOrder) {
        const arr = children[cn];
        out[cn] = arr.length === 1 ? arr[0] : arr;
      }
      if (trimmedText) out["#text"] = trimmedText;
      return out;
    }
  } catch {
    return null;
  }
}

function stripNs(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

function prefixAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[`@${k}`] = v;
  return out;
}

function cleanChild(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  const o = node as Record<string, unknown>;
  // Element with only _name + _value — collapse to value.
  const keys = Object.keys(o);
  if (keys.length === 2 && "_name" in o && "_value" in o) return o._value;
  // Otherwise drop the redundant _name (the parent stores us under our
  // tag name already) and keep the structure.
  const { _name, ...rest } = o;
  void _name;
  return rest;
}

function decodeEntities(s: string): string {
  if (!s) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
