import type { CustomPrompts } from '@/store/types';
import { effectivePrompt, substitute } from './promptDefaults';
import { termSelectionPrompt } from './termSelectionPrompt';
import { DEFAULT_MAX_L1_BULLETS } from './nodeContentType';
import { useSettingsStore } from '@/store/useSettingsStore';
import { chatFormattingPrompt } from './chatFormatting';


export interface ContextNode {
  header: string;
  body: string;
}

export interface PromptContext {
  parent: ContextNode | null;
  grandparent: ContextNode | null;
}

export type TaskVariant =
  | { kind: 'root'; topic: string; skipPendingSources?: boolean }
  | { kind: 'term-click'; term: string }
  | { kind: 'follow-up'; question: string; selectedText?: string }
  | { kind: 'modify'; previousBody: string; instruction: string; freeText?: boolean }
  | { kind: 'answer'; instruction: string; previousBody?: string; informationChunking: boolean }
  | { kind: 'modify-selection'; markedBody: string; selectedText: string; instruction: string; mode: 'encyclopedic' | 'explain' | 'answer'; informationChunking?: boolean; partCount?: number }
  | { kind: 'elaborate'; previousBody: string }
  /** Body has the target section delimited by literal `<<<EXPAND>>>` /
   *  `<<<END>>>` markers. The LLM is instructed to expand only that
   *  section by adding new concrete information while preserving the
   *  unmarked portions of the body verbatim. */
  | { kind: 'expand-part'; markedBody: string; mode?: 'encyclopedic' | 'explain' }
  /** "Pop selected": write a fresh node for a bullet extracted into its own
   *  child — opening paragraph + the sub-points regrouped into ≥2 named
   *  groups. `title` = the bullet's title (also the node header); `bulletBody`
   *  = the extracted sub-points as a flat markdown list. */
  | { kind: 'pop-rework'; title: string; bulletBody: string }
  /** Internal corrective pass: the previous output broke the two-level bullet
   *  structure (fewer than 2 level-1 bullets each with ≥2 level-2 children).
   *  Re-asks the model to rewrite `previousBody` into the correct structure,
   *  keeping all content. Fired automatically once after a failed generation. */
  | { kind: 'restructure'; previousBody: string }
  /** Pass 2: select terms from a finished body as JSON. Local insertion adds
   *  markers without rewriting prose. Uses NO graph context. */
  | { kind: 'add-chips'; plainBody: string }
  /** "Explain" selection action: a single plain ELI5 paragraph. Routed through
   *  the free-text `explainBase` system prompt (NOT the bulleted `base`) and
   *  kept out of the structure-check and chip passes. `term` is the selected
   *  text. Keeps graph context so the ELI5 knows what the term refers to. */
  | { kind: 'explain'; term: string }
  /** Evidence-guided whole-node rewrite. The evidence catalog is already
   * searched and validated; this pass must not search again. */
  | {
    kind: 'fact-rewrite';
    previousBody: string;
    evidenceReport: string;
    sourceCatalog: string;
    freeText?: boolean;
  };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ContextVars {
  [key: string]: string;
  parentHeader: string;
  parentBody: string;
  grandparentHeader: string;
  grandparentBody: string;
  parentBlock: string;
  grandparentBlock: string;
}

function contextVars(ctx: PromptContext): ContextVars {
  const parentBlock = ctx.parent
    ? `Parent node (immediate parent of the new node) — "${ctx.parent.header}":\n${ctx.parent.body}\n\n`
    : '';
  const grandparentBlock = ctx.grandparent
    ? `Grandparent node (parent of that parent) — "${ctx.grandparent.header}":\n${ctx.grandparent.body}\n\n`
    : '';
  return {
    parentHeader: ctx.parent?.header ?? '',
    parentBody: ctx.parent?.body ?? '',
    grandparentHeader: ctx.grandparent?.header ?? '',
    grandparentBody: ctx.grandparent?.body ?? '',
    parentBlock,
    grandparentBlock,
  };
}

function buildContextBlock(ctx: PromptContext, custom: Partial<CustomPrompts> | undefined): string {
  if (!ctx.parent && !ctx.grandparent) return '';
  const tpl = effectivePrompt('contextBlockTemplate', custom);
  return substitute(tpl, contextVars(ctx));
}

function buildTaskBlock(variant: TaskVariant, custom: Partial<CustomPrompts> | undefined): string {
  switch (variant.kind) {
    case 'answer':
      return substitute(effectivePrompt('taskAnswer', custom), {
        previousAnswer: variant.previousBody ? substitute(effectivePrompt('taskAnswerPrevious', custom), { previousBody: variant.previousBody }) : '',
        instruction: variant.instruction,
      });
    case 'root':
      return substitute(effectivePrompt('taskRoot', custom), { topic: variant.topic });
    case 'term-click':
      return substitute(effectivePrompt('taskTermClick', custom), { term: variant.term });
    case 'follow-up': {
      const selectionBlock = variant.selectedText
        ? substitute(effectivePrompt('followUpSelection', custom), { selectedText: variant.selectedText })
        : '';
      const built = substitute(effectivePrompt('taskFollowUp', custom), {
        question: variant.question,
        selectedText: variant.selectedText ?? '',
        selectionBlock,
      });
      // Custom legacy templates may not contain the new placeholder. Preserve
      // selected-text context anyway so a customized prompt cannot silently
      // turn this back into a whole-node question.
      return selectionBlock && !built.includes(variant.selectedText!) ? selectionBlock + built : built;
    }
    case 'modify':
      return substitute(effectivePrompt(variant.freeText ? 'taskModifyFree' : 'taskModify', custom), {
        previousBody: variant.previousBody,
        instruction: variant.instruction,
      });
    case 'modify-selection': {
      const built = substitute(effectivePrompt('taskModifySelection', custom), {
        markedBody: variant.markedBody,
        selectedText: variant.selectedText,
        instruction: variant.instruction,
      });
      if ((variant.partCount ?? 1) <= 1) return built;
      // The contract is editable; runtime validation still requires one
      // independently addressable replacement for each selected fragment.
      return `${built}\n\n${substitute(effectivePrompt('multiSelectionContract', custom), { partCount: String(variant.partCount) })}`;
    }
    case 'elaborate':
      return substitute(effectivePrompt('taskElaborate', custom), {
        previousBody: variant.previousBody,
      });
    case 'expand-part':
      return substitute(effectivePrompt(variant.mode === 'explain' ? 'taskExpandExplain' : 'taskExpandPart', custom), {
        markedBody: variant.markedBody,
      });
    case 'pop-rework':
      return substitute(effectivePrompt('taskPopRework', custom), {
        title: variant.title,
        bulletBody: variant.bulletBody,
      });
    case 'restructure':
      return substitute(effectivePrompt('taskRestructure', custom), {
        previousBody: variant.previousBody,
      });
    case 'add-chips':
      return substitute(effectivePrompt('taskAddChips', custom), {
        plainBody: variant.plainBody,
      });
    case 'explain':
      return substitute(effectivePrompt('taskExplain', custom), { term: variant.term });
    case 'fact-rewrite': {
      const built = substitute(effectivePrompt('taskRewriteWithEvidence', custom), {
        previousBody: variant.previousBody,
        evidenceReport: variant.evidenceReport,
        sourceCatalog: variant.sourceCatalog,
      });
      return `${built}\n\n${effectivePrompt('evidenceRewriteContract', custom)}`;
    }
  }
}

export function buildMessages(input: {
  variant: TaskVariant;
  context: PromptContext;
  /** Encyclopedic level-1 bullet cap to substitute into the `base` system
   *  prompt's `{maxLevel1}` placeholder. Defaults to DEFAULT_MAX_L1_BULLETS.
   *  Ignored by the explain / chip branches (their prompts have no placeholder). */
  maxLevel1?: number;
}): ChatMessage[] {
  const custom = useSettingsStore.getState().customPrompts;
  if (input.variant.kind === 'answer' || (input.variant.kind === 'modify-selection' && input.variant.mode === 'answer')) {
    return [
      { role: 'system', content: substitute(effectivePrompt('answerBase', custom), { formatting: chatFormattingPrompt(!!input.variant.informationChunking, useSettingsStore.getState().normalChatInstructions ?? '', custom, true) }) },
      { role: 'user', content: buildContextBlock(input.context, custom) + buildTaskBlock(input.variant, custom) },
    ];
  }
  // All term passes share the JSON selector prompt and omit graph context.
  if (input.variant.kind === 'add-chips') {
    const prompt = termSelectionPrompt(input.variant.plainBody, custom);
    return [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ];
  }
  // Evidence rewrites have a strict context boundary: the complete checked
  // node and its report are in the task itself; graph ancestors are excluded.
  if (input.variant.kind === 'fact-rewrite') {
    return [
      {
        role: 'system',
        content: input.variant.freeText
          ? effectivePrompt('explainBase', custom)
          : substitute(effectivePrompt('base', custom), {
            maxLevel1: String(input.maxLevel1 ?? DEFAULT_MAX_L1_BULLETS),
          }),
      },
      { role: 'user', content: buildTaskBlock(input.variant, custom) },
    ];
  }
  // "Explain" — and a Modify on a free-text node — use the plain ELI5 system
  // prompt instead of the bulleted `base`, so the result stays prose (no
  // bullets). Both keep the graph context so the model knows the subject.
  if (
    input.variant.kind === 'explain'
    || (input.variant.kind === 'modify' && input.variant.freeText)
    || (input.variant.kind === 'modify-selection' && input.variant.mode === 'explain')
    || (input.variant.kind === 'expand-part' && input.variant.mode === 'explain')
  ) {
    return [
      { role: 'system', content: effectivePrompt('explainBase', custom) },
      { role: 'user', content: buildContextBlock(input.context, custom) + buildTaskBlock(input.variant, custom) },
    ];
  }
  return [
    {
      role: 'system',
      content: substitute(effectivePrompt('base', custom), {
        maxLevel1: String(input.maxLevel1 ?? DEFAULT_MAX_L1_BULLETS),
      }),
    },
    { role: 'user', content: buildContextBlock(input.context, custom) + buildTaskBlock(input.variant, custom) },
  ];
}

export function buildFollowUpClassifierPrompt(input: {
  question: string;
  context: PromptContext;
  customPrompts?: Partial<CustomPrompts>;
}): string {
  const vars = contextVars(input.context);
  const contextBlock = buildContextBlock(input.context, input.customPrompts);
  return substitute(effectivePrompt('classifyFollowUp', input.customPrompts), {
    ...vars,
    contextBlock,
    header: vars.parentHeader,
    question: input.question,
  });
}
