/**
 * Liens routeur typés sur composants Mantine : `createLink` ne gère pas les composants
 * polymorphes, d'où des enveloppes non polymorphes (`forwardRef`) — recette documentée par TanStack.
 */
import {
  Anchor,
  Button,
  NavLink,
  UnstyledButton,
  type AnchorProps,
  type ButtonProps,
  type NavLinkProps,
  type UnstyledButtonProps,
} from '@mantine/core';
import { createLink, type LinkComponent } from '@tanstack/react-router';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';

type AnchorLikeProps<P> = P & Omit<ComponentPropsWithoutRef<'a'>, keyof P>;

const AnchorBase = forwardRef<HTMLAnchorElement, AnchorLikeProps<AnchorProps>>((props, ref) => (
  <Anchor ref={ref} {...props} />
));
AnchorBase.displayName = 'AnchorBase';
const CreatedAnchor = createLink(AnchorBase);
export const RouterAnchor: LinkComponent<typeof AnchorBase> = (props) => (
  <CreatedAnchor preload="intent" {...props} />
);

const NavLinkBase = forwardRef<HTMLAnchorElement, AnchorLikeProps<NavLinkProps>>((props, ref) => (
  <NavLink ref={ref} {...props} />
));
NavLinkBase.displayName = 'NavLinkBase';
const CreatedNavLink = createLink(NavLinkBase);
export const RouterNavLink: LinkComponent<typeof NavLinkBase> = (props) => (
  <CreatedNavLink preload="intent" {...props} />
);

const ButtonBase = forwardRef<HTMLAnchorElement, AnchorLikeProps<ButtonProps>>((props, ref) => (
  <Button component="a" ref={ref} {...props} />
));
ButtonBase.displayName = 'ButtonBase';
const CreatedButton = createLink(ButtonBase);
export const RouterButton: LinkComponent<typeof ButtonBase> = (props) => (
  <CreatedButton preload="intent" {...props} />
);

const UnstyledBase = forwardRef<HTMLAnchorElement, AnchorLikeProps<UnstyledButtonProps>>(
  (props, ref) => <UnstyledButton component="a" ref={ref} {...props} />,
);
UnstyledBase.displayName = 'UnstyledBase';
const CreatedUnstyled = createLink(UnstyledBase);
export const RouterUnstyledButton: LinkComponent<typeof UnstyledBase> = (props) => (
  <CreatedUnstyled preload="intent" {...props} />
);
