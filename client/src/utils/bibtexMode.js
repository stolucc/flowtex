// BibTeX syntax highlighting for CodeMirror 6 (StreamLanguage)
// Field validation per entry type based on biblatex 3.21 spec

// Fields available to all entry types (special, custom, generic)
const UNIVERSAL_FIELDS = new Set([
  'abstract', 'annotation', 'label', 'shorthand', 'shorthandintro',
  'crossref', 'entryset', 'execute', 'gender', 'langid', 'langidopts', 'ids',
  'indexsorttitle', 'keywords', 'options', 'presort', 'related', 'relatedoptions',
  'relatedtype', 'relatedstring', 'sortkey', 'sortname', 'sortshorthand',
  'sorttitle', 'sortyear', 'xdata', 'xref',
  'namea', 'nameb', 'namec', 'nameatype', 'namebtype', 'namectype',
  'lista', 'listb', 'listc', 'listd', 'liste', 'listf',
  'usera', 'userb', 'userc', 'userd', 'usere', 'userf',
  'verba', 'verbb', 'verbc',
  'file', 'library', 'indextitle', 'shortauthor', 'shorteditor',
  'shortjournal', 'shortseries', 'shorttitle', 'pagination', 'bookpagination',
  'nameaddon', 'reprinttitle', 'entrysubtype',
]);

// Per-type field sets (required + optional merged)
const TYPE_FIELDS = {
  article: new Set([
    'author', 'title', 'journaltitle', 'journal', 'year', 'date',
    'translator', 'annotator', 'commentator', 'subtitle', 'titleaddon',
    'editor', 'editora', 'editorb', 'editorc', 'editortype', 'editoratype',
    'editorbtype', 'editorctype', 'journalsubtitle', 'journaltitleaddon',
    'issuetitle', 'issuesubtitle', 'issuetitleaddon', 'language', 'origlanguage',
    'series', 'volume', 'number', 'eid', 'issue', 'month', 'pages', 'version',
    'note', 'issn', 'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass',
    'eprinttype', 'url', 'urldate',
  ]),
  book: new Set([
    'author', 'title', 'year', 'date',
    'editor', 'editora', 'editorb', 'editorc', 'editortype', 'editoratype',
    'editorbtype', 'editorctype', 'translator', 'annotator', 'commentator',
    'introduction', 'foreword', 'afterword', 'subtitle', 'titleaddon',
    'maintitle', 'mainsubtitle', 'maintitleaddon', 'language', 'origlanguage',
    'volume', 'part', 'edition', 'volumes', 'series', 'number', 'note',
    'publisher', 'location', 'address', 'isbn', 'eid', 'chapter', 'pages',
    'pagetotal', 'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass',
    'eprinttype', 'url', 'urldate',
  ]),
  mvbook: new Set([
    'author', 'title', 'year', 'date',
    'editor', 'editora', 'editorb', 'editorc', 'editortype', 'editoratype',
    'editorbtype', 'editorctype', 'translator', 'annotator', 'commentator',
    'introduction', 'foreword', 'afterword', 'subtitle', 'titleaddon',
    'language', 'origlanguage', 'edition', 'volumes', 'series', 'number',
    'note', 'publisher', 'location', 'address', 'isbn', 'pagetotal',
    'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype',
    'url', 'urldate',
  ]),
  inbook: new Set([
    'author', 'title', 'booktitle', 'year', 'date',
    'bookauthor', 'editor', 'editora', 'editorb', 'editorc', 'editortype',
    'editoratype', 'editorbtype', 'editorctype', 'translator', 'annotator',
    'commentator', 'introduction', 'foreword', 'afterword', 'subtitle',
    'titleaddon', 'maintitle', 'mainsubtitle', 'maintitleaddon', 'booksubtitle',
    'booktitleaddon', 'language', 'origlanguage', 'volume', 'part', 'edition',
    'volumes', 'series', 'number', 'note', 'publisher', 'location', 'address',
    'isbn', 'eid', 'chapter', 'pages', 'addendum', 'pubstate', 'doi',
    'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  incollection: new Set([
    'author', 'title', 'editor', 'booktitle', 'year', 'date',
    'editora', 'editorb', 'editorc', 'editortype', 'editoratype', 'editorbtype',
    'editorctype', 'translator', 'annotator', 'commentator', 'introduction',
    'foreword', 'afterword', 'subtitle', 'titleaddon', 'maintitle',
    'mainsubtitle', 'maintitleaddon', 'booksubtitle', 'booktitleaddon',
    'language', 'origlanguage', 'volume', 'part', 'edition', 'volumes',
    'series', 'number', 'note', 'publisher', 'location', 'address', 'isbn',
    'eid', 'chapter', 'pages', 'addendum', 'pubstate', 'doi', 'eprint',
    'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  inproceedings: new Set([
    'author', 'title', 'booktitle', 'year', 'date',
    'editor', 'subtitle', 'titleaddon', 'maintitle', 'mainsubtitle',
    'maintitleaddon', 'booksubtitle', 'booktitleaddon', 'eventtitle',
    'eventtitleaddon', 'eventdate', 'venue', 'language', 'volume', 'part',
    'volumes', 'series', 'number', 'note', 'organization', 'publisher',
    'location', 'address', 'month', 'isbn', 'eid', 'chapter', 'pages',
    'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype',
    'url', 'urldate',
  ]),
  proceedings: new Set([
    'title', 'year', 'date',
    'editor', 'subtitle', 'titleaddon', 'maintitle', 'mainsubtitle',
    'maintitleaddon', 'eventtitle', 'eventtitleaddon', 'eventdate', 'venue',
    'language', 'volume', 'part', 'volumes', 'series', 'number', 'note',
    'organization', 'publisher', 'location', 'address', 'month', 'isbn',
    'eid', 'chapter', 'pages', 'pagetotal', 'addendum', 'pubstate', 'doi',
    'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  mvproceedings: new Set([
    'title', 'year', 'date',
    'editor', 'subtitle', 'titleaddon', 'eventtitle', 'eventtitleaddon',
    'eventdate', 'venue', 'language', 'volumes', 'series', 'number', 'note',
    'organization', 'publisher', 'location', 'address', 'month', 'isbn',
    'pagetotal', 'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass',
    'eprinttype', 'url', 'urldate',
  ]),
  collection: new Set([
    'editor', 'title', 'year', 'date',
    'editora', 'editorb', 'editorc', 'editortype', 'editoratype', 'editorbtype',
    'editorctype', 'translator', 'annotator', 'commentator', 'introduction',
    'foreword', 'afterword', 'subtitle', 'titleaddon', 'maintitle',
    'mainsubtitle', 'maintitleaddon', 'language', 'origlanguage', 'volume',
    'part', 'edition', 'volumes', 'series', 'number', 'note', 'publisher',
    'location', 'address', 'isbn', 'eid', 'chapter', 'pages', 'pagetotal',
    'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype',
    'url', 'urldate',
  ]),
  mvcollection: new Set([
    'editor', 'title', 'year', 'date',
    'editora', 'editorb', 'editorc', 'editortype', 'editoratype', 'editorbtype',
    'editorctype', 'translator', 'annotator', 'commentator', 'introduction',
    'foreword', 'afterword', 'subtitle', 'titleaddon', 'language',
    'origlanguage', 'edition', 'volumes', 'series', 'number', 'note',
    'publisher', 'location', 'address', 'isbn', 'pagetotal', 'addendum',
    'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  booklet: new Set([
    'author', 'editor', 'title', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'howpublished', 'type', 'note',
    'location', 'address', 'eid', 'chapter', 'pages', 'pagetotal', 'addendum',
    'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  manual: new Set([
    'author', 'editor', 'title', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'edition', 'type', 'series',
    'number', 'version', 'note', 'organization', 'publisher', 'location',
    'address', 'isbn', 'eid', 'chapter', 'pages', 'pagetotal', 'addendum',
    'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  misc: new Set([
    'author', 'editor', 'title', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'howpublished', 'type', 'version',
    'note', 'organization', 'location', 'address', 'month', 'addendum',
    'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  online: new Set([
    'author', 'editor', 'title', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'version', 'note', 'organization',
    'month', 'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass',
    'eprinttype', 'url', 'urldate',
  ]),
  patent: new Set([
    'author', 'title', 'number', 'year', 'date',
    'holder', 'subtitle', 'titleaddon', 'type', 'version', 'location',
    'address', 'note', 'month', 'addendum', 'pubstate', 'doi', 'eprint',
    'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  periodical: new Set([
    'editor', 'title', 'year', 'date',
    'editora', 'editorb', 'editorc', 'editortype', 'editoratype', 'editorbtype',
    'editorctype', 'subtitle', 'titleaddon', 'issuetitle', 'issuesubtitle',
    'issuetitleaddon', 'language', 'series', 'volume', 'number', 'issue',
    'month', 'note', 'issn', 'addendum', 'pubstate', 'doi', 'eprint',
    'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  report: new Set([
    'author', 'title', 'type', 'institution', 'school', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'number', 'version', 'note',
    'location', 'address', 'month', 'isrn', 'eid', 'chapter', 'pages',
    'pagetotal', 'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass',
    'eprinttype', 'url', 'urldate',
  ]),
  thesis: new Set([
    'author', 'title', 'type', 'institution', 'school', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'note', 'location', 'address',
    'month', 'isbn', 'eid', 'chapter', 'pages', 'pagetotal', 'addendum',
    'pubstate', 'doi', 'eprint', 'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  unpublished: new Set([
    'author', 'title', 'year', 'date',
    'subtitle', 'titleaddon', 'type', 'eventtitle', 'eventtitleaddon',
    'eventdate', 'venue', 'language', 'howpublished', 'note', 'location',
    'address', 'isbn', 'month', 'addendum', 'pubstate', 'doi', 'eprint',
    'eprintclass', 'eprinttype', 'url', 'urldate',
  ]),
  dataset: new Set([
    'author', 'editor', 'title', 'year', 'date',
    'subtitle', 'titleaddon', 'language', 'edition', 'type', 'series',
    'number', 'version', 'note', 'organization', 'publisher', 'location',
    'address', 'addendum', 'pubstate', 'doi', 'eprint', 'eprintclass',
    'eprinttype', 'url', 'urldate',
  ]),
};

// Aliases that share field sets with another type
TYPE_FIELDS.conference = TYPE_FIELDS.inproceedings;
TYPE_FIELDS.bookinbook = TYPE_FIELDS.inbook;
TYPE_FIELDS.suppbook = TYPE_FIELDS.inbook;
TYPE_FIELDS.suppcollection = TYPE_FIELDS.incollection;
TYPE_FIELDS.reference = TYPE_FIELDS.collection;
TYPE_FIELDS.mvreference = TYPE_FIELDS.mvcollection;
TYPE_FIELDS.inreference = TYPE_FIELDS.incollection;
TYPE_FIELDS.suppperiodical = TYPE_FIELDS.article;
TYPE_FIELDS.mastersthesis = TYPE_FIELDS.thesis;
TYPE_FIELDS.phdthesis = TYPE_FIELDS.thesis;
TYPE_FIELDS.techreport = TYPE_FIELDS.report;
TYPE_FIELDS.electronic = TYPE_FIELDS.online;
TYPE_FIELDS.www = TYPE_FIELDS.online;
TYPE_FIELDS.software = TYPE_FIELDS.misc;

// All known fields (union of everything) for general recognition
export const ALL_KNOWN_FIELDS = new Set();
for (const f of UNIVERSAL_FIELDS) ALL_KNOWN_FIELDS.add(f);
for (const fields of Object.values(TYPE_FIELDS)) {
  for (const f of fields) ALL_KNOWN_FIELDS.add(f);
}
// BibTeX aliases
for (const f of ['address', 'annote', 'archiveprefix', 'journal', 'key', 'pdf', 'primaryclass', 'school']) {
  ALL_KNOWN_FIELDS.add(f);
}

/**
 * Check whether a BibTeX field is valid for the given entry type.
 * @param {string} fieldName - Lowercase field name
 * @param {string} entryType - Lowercase entry type (e.g. 'article', 'book')
 * @returns {boolean}
 */
export function isFieldValidForType(fieldName, entryType) {
  if (UNIVERSAL_FIELDS.has(fieldName)) return true;
  const typeFields = TYPE_FIELDS[entryType];
  if (!typeFields) return true; // unknown entry type — don't flag fields
  return typeFields.has(fieldName);
}

export const bibtex = {
  name: 'bibtex',
  startState() {
    return { inEntry: false, inKey: false, braceDepth: 0, entryType: '' };
  },
  token(stream, state) {
    if (stream.eatSpace()) return null;

    // Comments
    if (!state.inEntry && stream.peek() === '%') {
      stream.skipToEnd();
      return 'comment';
    }

    // Entry type: @article, @book, @string, @preamble, @comment
    if (!state.inEntry && stream.match(/@\w+/)) {
      state.inEntry = true;
      state.inKey = true;
      state.entryType = stream.current().slice(1).toLowerCase();
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
      if (stream.match(/[a-zA-Z_][a-zA-Z0-9_-]*(?=\s*=)/)) {
        const name = stream.current().toLowerCase();
        if (!ALL_KNOWN_FIELDS.has(name)) return 'error';              // unknown field — red
        if (!isFieldValidForType(name, state.entryType)) return 'comment';  // wrong type — dark orange/brown
        return 'keyword';                                            // valid — purple
      }

      if (stream.eat('=')) return 'operator';
      if (stream.eat(',')) return 'punctuation';
      if (stream.match(/\d+/)) return 'number';
      if (stream.eat('#')) return 'operator';

      // Braced value
      if (ch === '{') {
        stream.next();
        state.braceDepth++;
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
          state.entryType = '';
        }
        return 'bracket';
      }

      // String macro references (unquoted words as values)
      if (stream.match(/[a-zA-Z]\w*/)) return 'variableName.special';

      stream.next();
      return null;
    }

    // Outside entries — treat as comment
    stream.skipToEnd();
    return 'comment';
  },
};
