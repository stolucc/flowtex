// BibTeX syntax highlighting for CodeMirror 6 (StreamLanguage)

export const bibtex = {
  name: 'bibtex',
  startState() {
    return { inEntry: false, inKey: false, inField: false, braceDepth: 0 };
  },
  token(stream, state) {
    // Whitespace
    if (stream.eatSpace()) return null;

    // Comments (lines starting with % or @comment entries)
    if (!state.inEntry && stream.peek() === '%') {
      stream.skipToEnd();
      return 'comment';
    }

    // Entry type: @article, @book, @string, @preamble, @comment
    if (!state.inEntry && stream.match(/@\w+/)) {
      state.inEntry = true;
      state.inKey = true;
      return 'keyword';
    }

    // Opening brace/paren of entry
    if (state.inKey && (stream.peek() === '{' || stream.peek() === '(')) {
      stream.next();
      state.braceDepth = 1;
      return 'bracket';
    }

    // Citation key (first token after opening brace, before comma)
    if (state.inKey && stream.match(/[^,}\s]+/)) {
      state.inKey = false;
      return 'atom';
    }

    if (state.inKey && stream.eat(',')) {
      state.inKey = false;
      return 'punctuation';
    }

    // Inside entry body
    if (state.inEntry && state.braceDepth > 0) {
      const ch = stream.peek();

      // Field name (word before =)
      if (stream.match(/[a-zA-Z_][a-zA-Z0-9_-]*\s*(?==)/)) {
        return 'propertyName';
      }

      // Equals sign
      if (stream.eat('=')) return 'operator';

      // Comma between fields
      if (stream.eat(',')) return 'punctuation';

      // Numbers
      if (stream.match(/\d+/)) return 'number';

      // String concatenation
      if (stream.eat('#')) return 'operator';

      // Braced value — track depth
      if (ch === '{') {
        stream.next();
        state.braceDepth++;
        // Consume until matching close brace at this level
        const target = state.braceDepth;
        while (!stream.eol()) {
          const c = stream.next();
          if (c === '{') state.braceDepth++;
          else if (c === '}') {
            state.braceDepth--;
            if (state.braceDepth < target) break;
          }
        }
        return 'string';
      }

      // Quoted string
      if (ch === '"') {
        stream.next();
        let depth = 0;
        while (!stream.eol()) {
          const c = stream.next();
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '"' && depth === 0) break;
        }
        return 'string';
      }

      // Closing brace/paren of entry
      if (ch === '}' || ch === ')') {
        stream.next();
        state.braceDepth--;
        if (state.braceDepth <= 0) {
          state.inEntry = false;
          state.inKey = false;
          state.braceDepth = 0;
        }
        return 'bracket';
      }

      // String macro references (unquoted words as values)
      if (stream.match(/[a-zA-Z]\w*/)) return 'variableName';

      // Skip anything else
      stream.next();
      return null;
    }

    // Outside entries — treat as comment
    stream.skipToEnd();
    return 'comment';
  },
};
