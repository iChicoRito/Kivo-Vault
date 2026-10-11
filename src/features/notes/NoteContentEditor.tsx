import { useEffect, useRef } from 'react'
import { ScrollShadow, Separator, ToggleButton, Toolbar, Typography } from '@heroui/react'
import { CharacterCount } from '@tiptap/extensions'
import { TextAlign } from '@tiptap/extension-text-align'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import {
  Heading02Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  QuoteUpIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

/** The note body limit the counter under the editor reads. */
const NOTE_CONTENT_LIMIT = 18000

type NoteContentEditorProps = {
  /** Editor-ready HTML the note holds today. */
  initialHtml: string
  /** Runs on every edit with the note body as HTML. */
  onChange: (html: string) => void
  /** Save state shown at the right end of the counter line. */
  status: string
}

/**
 * The note body: a rich text surface with the formatting toolbar the design
 * calls for and the character counter under it. The toolbar pill floats in the
 * editor's bottom-right corner, so the text keeps clear of it. The box holds a
 * set height and the body scrolls inside behind HeroUI's scroll shadow, so a
 * long note never grows the page and the cut-off edge fades.
 */
export function NoteContentEditor({ initialHtml, onChange, status }: NoteContentEditorProps) {
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  })

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      CharacterCount.configure({ limit: NOTE_CONTENT_LIMIT }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        'aria-label': 'Content',
        'aria-multiline': 'true',
        class: 'kivo-note-body',
        role: 'textbox',
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getHTML())
    },
  })

  return (
    <div className="grid gap-3">
      <div className="relative flex h-[60vh] min-h-[24rem] min-w-0 flex-col rounded-3xl bg-background-secondary">
        <ScrollShadow className="kivo-note-field min-h-0 flex-1 overscroll-contain text-base leading-7">
          <EditorContent editor={editor} />
        </ScrollShadow>
        <div className="absolute right-4 bottom-4">
          <EditorToolbar editor={editor} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <CharacterCounter editor={editor} />
        <Typography aria-live="polite" color="muted" type="body-xs">
          {status}
        </Typography>
      </div>
    </div>
  )
}

/**
 * The count lives in the extension's storage rather than TipTap's React
 * snapshot, so this line reads it through the editor state hook that re-renders
 * on every transaction. It turns danger at the limit, where typing stops.
 */
function CharacterCounter({ editor }: { editor: Editor }) {
  const characters = useEditorState({
    editor,
    selector: ({ editor }) => characterCount(editor),
  })

  return (
    <Typography
      className={characters >= NOTE_CONTENT_LIMIT ? 'text-danger' : 'text-muted'}
      type="body-xs"
    >
      {`Characters: ${characters}/${NOTE_CONTENT_LIMIT}`}
    </Typography>
  )
}

type CharacterCountStorage = {
  characters: () => number
}

function characterCount(editor: Editor): number {
  const storage = editor.storage as { characterCount?: CharacterCountStorage }

  return storage.characterCount?.characters() ?? 0
}

function EditorToolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      heading: editor.isActive('heading', { level: 2 }),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      blockquote: editor.isActive('blockquote'),
      alignLeft: editor.isActive({ textAlign: 'left' }),
      alignCenter: editor.isActive({ textAlign: 'center' }),
      alignRight: editor.isActive({ textAlign: 'right' }),
    }),
  })

  return (
    <Toolbar aria-label="Text formatting" className="gap-1" isAttached>
      <ToggleButton
        isIconOnly
        aria-label="Align left"
        isSelected={active.alignLeft}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().setTextAlign('left').run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={TextAlignLeftIcon} size={18} />
      </ToggleButton>
      <ToggleButton
        isIconOnly
        aria-label="Align center"
        isSelected={active.alignCenter}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().setTextAlign('center').run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={TextAlignCenterIcon} size={18} />
      </ToggleButton>
      <ToggleButton
        isIconOnly
        aria-label="Align right"
        isSelected={active.alignRight}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().setTextAlign('right').run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={TextAlignRightIcon} size={18} />
      </ToggleButton>

      <Separator orientation="vertical" />

      <ToggleButton
        aria-label="Bold"
        className="font-bold"
        isSelected={active.bold}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </ToggleButton>
      <ToggleButton
        aria-label="Italic"
        className="italic"
        isSelected={active.italic}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </ToggleButton>
      <ToggleButton
        aria-label="Strikethrough"
        className="line-through"
        isSelected={active.strike}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleStrike().run()}
      >
        S
      </ToggleButton>

      <Separator orientation="vertical" />

      <ToggleButton
        isIconOnly
        aria-label="Heading 2"
        isSelected={active.heading}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={Heading02Icon} size={18} />
      </ToggleButton>
      <ToggleButton
        isIconOnly
        aria-label="Bullet list"
        isSelected={active.bulletList}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleBulletList().run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={LeftToRightListBulletIcon} size={18} />
      </ToggleButton>
      <ToggleButton
        isIconOnly
        aria-label="Numbered list"
        isSelected={active.orderedList}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={LeftToRightListNumberIcon} size={18} />
      </ToggleButton>
      <ToggleButton
        isIconOnly
        aria-label="Quote"
        isSelected={active.blockquote}
        size="sm"
        variant="ghost"
        onChange={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <HugeiconsIcon aria-hidden="true" icon={QuoteUpIcon} size={18} />
      </ToggleButton>
    </Toolbar>
  )
}

export default NoteContentEditor
