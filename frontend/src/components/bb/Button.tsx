import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline' | 'ghost';
  size?: 'sm' | 'md';
  label: string;
}

const SIZE = {
  sm: 'h-9 px-4 text-[13px]',
  md: 'h-10 px-5 text-[13.5px]',
} as const;

const VARIANT = {
  primary: 'bb-btn-primary',
  outline: 'bb-btn-secondary',
  ghost: 'bb-btn-ghost',
} as const;

/** Pill button, the landing's shape. Primary is the invert fill (cream on
 * dark, near-black on paper); outline is a hairline pill; ghost is text
 * until hovered. */
export function Button({ variant = 'outline', size = 'md', label, className = '', ...props }: ButtonProps) {
  return (
    <button className={`bb-btn ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...props}>
      {label}
    </button>
  );
}

interface ButtonLinkProps extends LinkProps {
  variant?: 'primary' | 'outline' | 'ghost';
  size?: 'sm' | 'md';
  label: string;
}

/** A link that looks like Button, for navigation. A <button> inside a <Link>
 *  is invalid nesting: two interactive elements, and two tab stops. */
export function ButtonLink({ variant = 'outline', size = 'md', label, className = '', ...props }: ButtonLinkProps) {
  return (
    <Link className={`bb-btn ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...props}>
      {label}
    </Link>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; the button shows only its icon. */
  label: string;
  children: ReactNode;
  variant?: 'outline' | 'solid' | 'ghost';
  size?: 'sm' | 'md';
}

// Static map, not `bb-icon-btn-${variant}`: Tailwind only keeps component
// classes it can find spelled out in the source.
const ICON_VARIANT = {
  outline: 'bb-icon-btn-outline',
  solid: 'bb-icon-btn-solid',
  ghost: 'bb-icon-btn-ghost',
} as const;

/** Classes for a round icon control, for links that need the same look. */
export function iconButtonClass(variant: NonNullable<IconButtonProps['variant']> = 'outline', size: IconButtonProps['size'] = 'sm') {
  const box = size === 'sm' ? 'h-9 w-9' : 'h-10 w-10';
  return `bb-icon-btn ${ICON_VARIANT[variant]} ${box}`;
}

/** Round icon button: the landing's circle arrow, and the top bar's bell,
 * theme toggle and avatar. `solid` is the invert fill. */
export function IconButton({ label, children, variant = 'outline', size = 'sm', className = '', ...props }: IconButtonProps) {
  return (
    <button type="button" aria-label={label} title={label} className={`${iconButtonClass(variant, size)} ${className}`} {...props}>
      {children}
    </button>
  );
}
