export function SiteFooter({ agency, clientName }: { agency: string; clientName: string }) {
  return (
    <footer className="footer">
      <p>
        An independent proposal concept by {agency}, pending {clientName} approval. Not affiliated with or endorsed by{' '}
        {clientName}. Finishes marked “demo” and feature notes marked “placeholder” are for illustration only.
      </p>
      <p className="footer__keys">
        Keyboard: focus the viewer, then use <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> to rotate and{' '}
        <kbd>+</kbd> <kbd>−</kbd> to zoom.
      </p>
    </footer>
  );
}
