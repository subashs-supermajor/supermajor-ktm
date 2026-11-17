import type { HTMLAttributes, Ref } from 'react';

// Augment react/jsx-runtime so TypeScript accepts <model-viewer> in JSX.
declare module 'react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': HTMLAttributes<HTMLElement> & {
        /** React 18 only forwards `class` (not `className`) to custom elements. */
        class?: string;
        src?: string;
        alt?: string;
        ar?: '' | boolean;
        'ar-modes'?: string;
        'ar-scale'?: string;
        'ar-placement'?: 'floor' | 'wall' | string;
        'ar-usdz-max-texture-size'?: string;
        'ios-src'?: string;
        'camera-controls'?: '' | boolean;
        'camera-orbit'?: string;
        'auto-rotate'?: '' | boolean;
        'shadow-intensity'?: string | number;
        'environment-image'?: string;
        loading?: string;
        reveal?: string;
        poster?: string;
        exposure?: string | number;
        'tone-mapping'?: 'none' | 'agx' | 'aces' | 'commerce' | 'neutral' | 'reinhard';
        'ar-placement'?: 'floor' | 'wall';
        'ar-usdz-max-texture-size'?: string | number;
        ref?: Ref<HTMLElement>;
      };
    }
  }
}
