import { File, Paths } from 'expo-file-system';
// The default entry point is the "next" API, whose native module is missing from
// Expo Go. The legacy API ships with Expo Go and with development builds.
import * as MediaLibrary from 'expo-media-library/legacy';

export class SaveError extends Error {}

export function artworkFilename(albumName) {
  const safe = albumName.replace(/[^a-z0-9]/gi, '_').slice(0, 60) || 'album';
  return `${safe}.jpg`;
}

// Downloads cover art to the cache, then hands it to the OS photo library.
// Write-only permission is enough to add a photo and avoids asking the user
// for read access to their entire library.
export async function saveArtwork(url, filename) {
  const permission = await MediaLibrary.requestPermissionsAsync(true);

  if (!permission.granted) {
    throw new SaveError(
      permission.canAskAgain
        ? 'Permission is needed to save to your photos.'
        : 'Enable photo access for Lookups in your device settings to save covers.'
    );
  }

  const destination = new File(Paths.cache, filename);

  let downloaded;
  try {
    downloaded = await File.downloadFileAsync(url, destination, { idempotent: true });
  } catch {
    throw new SaveError('Could not download that cover.');
  }

  try {
    await MediaLibrary.saveToLibraryAsync(downloaded.uri);
  } catch {
    throw new SaveError('Could not save that cover to your photos.');
  } finally {
    // The photo library keeps its own copy, so the cached file is dead weight.
    try {
      downloaded.delete();
    } catch {
      // Cache eviction will handle it.
    }
  }
}
