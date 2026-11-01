// Text with any web address in it made into a link (e.g. where to turn on a Google API).
export default function Linked({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s)]+)/).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  )
}
