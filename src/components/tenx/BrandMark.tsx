// 10X RPC — shared brand mark.
// The logo is the white "10" + red "X" tile (black background). Rendered as a
// rounded black tile with a hairline ring so it reads cleanly on any surface
// (dark landing, glass cards, light favicon contexts). Size and extras come
// in via className (w-9 h-9, mx-auto, animate-pulse, …).
export function BrandMark({ className = 'w-9 h-9', rounded = 'rounded-xl' }: { className?: string; rounded?: string }) {
  return (
    <div
      className={`${className} ${rounded} overflow-hidden bg-black ring-1 ring-white/15 flex items-center justify-center`}
      aria-hidden="true"
    >
      <img
        src="/logo.png"
        alt=""
        className="w-full h-full object-cover select-none"
        draggable={false}
      />
    </div>
  )
}
