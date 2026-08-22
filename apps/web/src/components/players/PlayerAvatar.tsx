/**
 * Avatar d'un joueur : tête du skin via mc-heads.net (UUID Mojang ou pseudo), repli sur les
 * initiales (hors ligne, UUID v3 du mode hors ligne, compte inconnu, réseau coupé).
 */
import { Avatar, type AvatarProps } from '@mantine/core';
import { useState } from 'react';

/** UUID v3 = dérivé du pseudo (mode hors ligne) : aucun skin associé. */
export function isOfflineUuid(uuid: string | null | undefined): boolean {
  return uuid?.charAt(14) === '3';
}

export function avatarUrl(name: string, uuid: string | null | undefined, size = 40): string {
  const id = uuid !== null && uuid !== undefined && !isOfflineUuid(uuid) ? uuid : name;
  return `https://mc-heads.net/avatar/${encodeURIComponent(id)}/${String(size)}`;
}

export function PlayerAvatar({
  name,
  uuid,
  size = 32,
  ...props
}: { name: string; uuid?: string | null | undefined; size?: number } & Omit<
  AvatarProps,
  'size' | 'src' | 'name'
>) {
  const [failed, setFailed] = useState(false);
  return (
    <Avatar
      size={size}
      radius="sm"
      name={name}
      color="initials"
      src={failed ? null : avatarUrl(name, uuid, size * 2)}
      imageProps={{
        onError: () => {
          setFailed(true);
        },
        loading: 'lazy',
      }}
      alt={name}
      data-testid="player-avatar"
      {...props}
    />
  );
}
