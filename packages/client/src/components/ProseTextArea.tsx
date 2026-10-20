interface ProseTextAreaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
}

export default function ProseTextArea({ value, onChange, placeholder, rows }: ProseTextAreaProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      autoCorrect="on"
      autoCapitalize="sentences"
      spellCheck={true}
      autoComplete="on"
      inputMode="text"
      enterKeyHint="enter"
      className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-base sm:text-sm resize-y"
    />
  );
}
