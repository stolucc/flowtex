// @ts-check
/** Catalog of LLM tasks the right-click menu can dispatch.
 *
 *  Each `task` MUST match a server-side allowlist entry in
 *  helper/llm.go (`validTasks` map). Adding a new entry here without
 *  the matching server-side template is a no-op — the helper returns
 *  "unknown task" and the dialog surfaces it as an error.
 *
 *  Kept in its own tiny module so the Editor right-click menu can
 *  enumerate the items without pulling in the dialog (and its
 *  helperBridge imports) — the dialog is lazy-loaded only when the
 *  user actually picks an item.
 */
export const LLM_TASKS = {
  'write-to-length': {
    label: 'Write to length…',
    hint: 'rewrite to N words',
    title: 'Write to length',
    needsTargetWords: true,
  },
  paraphrase: {
    label: 'Paraphrase',
    hint: 'reword, same length',
    title: 'Paraphrase',
    needsTargetWords: false,
  },
  itemize: {
    label: 'Itemize',
    hint: 'prose → bullet points',
    title: 'Itemize',
    needsTargetWords: false,
  },
  'write-it-out': {
    label: 'Write it out',
    hint: 'bullets → prose paragraph',
    title: 'Write it out',
    needsTargetWords: false,
  },
  custom: {
    label: 'Other…',
    hint: 'free-form instruction',
    title: 'Custom instruction',
    needsTargetWords: false,
    needsInstruction: true,
  },
};
