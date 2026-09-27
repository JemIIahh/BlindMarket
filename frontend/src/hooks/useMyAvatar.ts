import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useWallet } from '../context/WalletContext';
import { ApiError, authedGet, authedPut } from '../lib/api';
import { parseAvatar, type SavedAvatar } from '../components/avatar/avatarOptions';
import { readFirstDeviceAvatar, saveDeviceAvatar } from '../components/avatar/deviceAvatars';

interface MyAvatar {
  avatar: SavedAvatar | null;
  /** The address the backend posts this person's tasks from, when it said. */
  address: string | null;
  /** 'device': development preview against an API without avatar routes. */
  source: 'server' | 'device';
}

/** An API that doesn't have the avatar routes yet answers 404 for them. */
const missingRoute = (err: unknown) => err instanceof ApiError && err.status === 404;

/**
 * The signed-in person's avatar: GET/PUT /api/v1/profile/avatar. The backend
 * saves it under every wallet on the account, so it shows on tasks posted
 * from any of them.
 *
 * In development only, when the API answers 404 (a local preview proxied to
 * a production API that doesn't have these routes yet), the avatar is kept in
 * this browser instead and `source` is 'device'.
 */
export function useMyAvatar() {
  const { isAuthenticated } = useAuth();
  const { address, embeddedAddress, externalAddresses } = useWallet();
  const qc = useQueryClient();
  const wallets = [...new Set([address, embeddedAddress, ...externalAddresses].filter((a): a is string => !!a).map((a) => a.toLowerCase()))];
  const queryKey = ['profile', 'avatar', wallets.join(',')];

  const query = useQuery({
    queryKey,
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
    retry: (count, err) => !missingRoute(err) && count < 1,
    queryFn: async (): Promise<MyAvatar> => {
      try {
        const data = await authedGet<{ avatar: unknown; address?: string }>('/api/v1/profile/avatar');
        return { avatar: parseAvatar(data.avatar), address: data.address ?? null, source: 'server' };
      } catch (err) {
        if (import.meta.env.DEV && missingRoute(err)) {
          return { avatar: readFirstDeviceAvatar(wallets), address: null, source: 'device' };
        }
        throw err;
      }
    },
  });

  const saveOnDevice = (avatar: SavedAvatar): MyAvatar => {
    if (!saveDeviceAvatar(wallets, avatar)) throw new Error("This browser won't store the preview avatar (storage is blocked).");
    return { avatar, address: null, source: 'device' };
  };

  const mutation = useMutation({
    mutationFn: async (avatar: SavedAvatar): Promise<MyAvatar> => {
      if (import.meta.env.DEV && query.data?.source === 'device') return saveOnDevice(avatar);
      try {
        const data = await authedPut<{ avatar: unknown; address?: string }>('/api/v1/profile/avatar', { avatar });
        return { avatar: parseAvatar(data.avatar), address: data.address ?? null, source: 'server' };
      } catch (err) {
        if (import.meta.env.DEV && missingRoute(err)) return saveOnDevice(avatar);
        throw err;
      }
    },
    onSuccess: (saved) => {
      qc.setQueryData(queryKey, saved);
      // Task lists and pages carry each poster's avatar: fetch them again.
      if (saved.source === 'server') {
        qc.invalidateQueries({ queryKey: ['a2a', 'tasks'] });
        qc.invalidateQueries({ queryKey: ['tasks'] });
      }
    },
  });

  return {
    avatar: query.data?.avatar ?? null,
    /** What the default face is drawn from until an avatar is saved. */
    seed: query.data?.address ?? wallets[0] ?? 'you',
    source: query.data?.source ?? null,
    isLoading: query.isLoading,
    error: query.error,
    save: mutation.mutateAsync,
    saving: mutation.isPending,
    saveError: mutation.error,
    signedIn: isAuthenticated,
  };
}
