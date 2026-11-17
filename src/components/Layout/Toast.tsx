import { useCallback, useEffect, useRef, useState } from 'react';

export function useToast(duration = 3200) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number>();

  const show = useCallback(
    (text: string) => {
      window.clearTimeout(timer.current);
      setMessage(text);
      timer.current = window.setTimeout(() => setMessage(null), duration);
    },
    [duration],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { message, show };
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div className="toast" role="status" aria-live="polite" data-open={Boolean(message)}>
      {message}
    </div>
  );
}
