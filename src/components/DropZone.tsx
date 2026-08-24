import { useCallback, useRef, useState } from 'react';

interface Props {
  label: string;
  hint: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}

const isFBX = (f: File) => f.name.toLowerCase().endsWith('.fbx');

export function DropZone({ label, hint, multiple, disabled, onFiles }: Props) {
  const [hot, setHot] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const accept = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const files = Array.from(list);
      const fbx = files.filter(isFBX);
      setRejected(
        fbx.length === files.length
          ? null
          : `Skipped ${files.length - fbx.length} non-FBX file(s).`,
      );
      if (fbx.length > 0) onFiles(multiple ? fbx : [fbx[0]]);
    },
    [multiple, onFiles],
  );

  return (
    <div>
      <div
        className={`dropzone${hot ? ' is-hot' : ''}${disabled ? ' is-disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHot(false);
          if (!disabled) accept(e.dataTransfer.files);
        }}
        onClick={() => !disabled && input.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) input.current?.click();
        }}
      >
        <span className="dropzone-label">{label}</span>
        <span className="dropzone-hint">{hint}</span>
        <input
          ref={input}
          type="file"
          accept=".fbx"
          multiple={multiple}
          hidden
          onChange={(e) => {
            accept(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {rejected && <p className="note note-warn">{rejected}</p>}
    </div>
  );
}
