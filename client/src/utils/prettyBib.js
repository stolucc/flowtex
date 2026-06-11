// @ts-check
import { findMatchingBrace } from './latexParser.js';

/**
 * Pretty-print a .bib file string.
 * Normalizes whitespace, aligns field names, and adds consistent formatting.
 * @param {string} input
 */
export default function prettyBib(input) {
  /** @type {string[]} */
  const result = [];
  let i = 0;
  const src = input;

  function skipWhitespace() {
    while (i < src.length && /\s/.test(src[i])) i++;
  }

  function readBraced() {
    // Read balanced braces content (assumes i is right after opening '{')
    const closeIdx = findMatchingBrace(src, i - 1, false);
    if (closeIdx === -1) {
      const s = src.slice(i);
      i = src.length;
      return s;
    }
    const s = src.slice(i, closeIdx);
    i = closeIdx; // leave i AT the closing }, matching original behavior
    return s;
  }

  function readFieldValue() {
    skipWhitespace();
    let value = '';
    while (i < src.length) {
      if (src[i] === '{') {
        i++; // skip {
        value += '{' + readBraced() + '}';
        if (i < src.length && src[i] === '}') i++; // skip closing }
      } else if (src[i] === '"') {
        i++; // skip opening "
        let s = '';
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '{') {
            i++;
            s += '{' + readBraced() + '}';
            if (i < src.length && src[i] === '}') i++;
          } else {
            s += src[i];
            i++;
          }
        }
        if (i < src.length) i++; // skip closing "
        value += '{' + s + '}';
      } else if (/[0-9]/.test(src[i])) {
        let num = '';
        while (i < src.length && /[0-9]/.test(src[i])) {
          num += src[i];
          i++;
        }
        value += '{' + num + '}';
      } else if (src[i] === '#') {
        value += ' # ';
        i++;
      } else if (src[i] === ',' || src[i] === '}') {
        break;
      } else {
        // macro name
        let macro = '';
        while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) {
          macro += src[i];
          i++;
        }
        if (macro) value += macro;
      }
      skipWhitespace();
    }
    return value.trim();
  }

  while (i < src.length) {
    skipWhitespace();
    if (i >= src.length) break;

    // Comments or non-entry text
    if (src[i] !== '@') {
      let comment = '';
      while (i < src.length && src[i] !== '@') {
        comment += src[i];
        i++;
      }
      const trimmed = comment.trim();
      if (trimmed) {
        result.push(trimmed);
        result.push('');
      }
      continue;
    }

    // Entry
    i++; // skip @
    let entryType = '';
    while (i < src.length && /[a-zA-Z]/.test(src[i])) {
      entryType += src[i];
      i++;
    }
    skipWhitespace();
    if (i >= src.length || src[i] !== '{') {
      result.push('@' + entryType);
      continue;
    }
    i++; // skip {

    // For @string, @preamble, @comment
    const typeLower = entryType.toLowerCase();
    if (typeLower === 'string' || typeLower === 'preamble' || typeLower === 'comment') {
      const content = readBraced();
      if (i < src.length && src[i] === '}') i++;
      if (typeLower === 'string') {
        // Parse name = value
        const eqIdx = content.indexOf('=');
        if (eqIdx > -1) {
          const sName = content.substring(0, eqIdx).trim();
          const sVal = content.substring(eqIdx + 1).trim();
          result.push(`@string{${sName} = ${sVal}}`);
        } else {
          result.push(`@string{${content.trim()}}`);
        }
      } else {
        result.push(`@${typeLower}{${content.trim()}}`);
      }
      result.push('');
      continue;
    }

    // Citation key
    skipWhitespace();
    let key = '';
    while (i < src.length && src[i] !== ',' && src[i] !== '}') {
      key += src[i];
      i++;
    }
    key = key.trim();
    if (i < src.length && src[i] === ',') i++; // skip ,

    // Fields
    const fields = [];
    while (i < src.length) {
      skipWhitespace();
      if (src[i] === '}') {
        i++;
        break;
      }

      // Field name
      let fieldName = '';
      while (i < src.length && src[i] !== '=' && src[i] !== '}' && src[i] !== ',') {
        fieldName += src[i];
        i++;
      }
      fieldName = fieldName.trim();
      if (!fieldName) {
        i++;
        continue;
      }

      if (i < src.length && src[i] === '=') {
        i++; // skip =
        const value = readFieldValue();
        fields.push({ name: fieldName.toLowerCase(), value });
        skipWhitespace();
        if (i < src.length && src[i] === ',') i++;
      } else {
        // malformed, skip
        if (i < src.length && (src[i] === ',' || src[i] === '}')) {
          if (src[i] === ',') i++;
        }
      }
    }

    // Find max field name length for alignment
    const maxLen = fields.reduce((m, f) => Math.max(m, f.name.length), 0);

    let entry = `@${typeLower}{${key},\n`;
    for (let fi = 0; fi < fields.length; fi++) {
      const f = fields[fi];
      const padded = f.name.padEnd(maxLen);
      entry += `  ${padded} = ${f.value}`;
      entry += fi < fields.length - 1 ? ',\n' : ',\n';
    }
    entry += '}';
    result.push(entry);
    result.push('');
  }

  // Remove trailing blank lines
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return result.join('\n') + '\n';
}
