export interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function renderButton(props: ButtonProps): string {
  return `<button ${props.disabled ? 'disabled' : ''} onclick="${props.onClick}">${props.label}</button>`;
}
