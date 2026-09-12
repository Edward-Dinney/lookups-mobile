import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ImageBackground,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getArtistAlbums,
  largestImage,
  searchArtists,
  searchTopArtistAlbums,
  SpotifyError,
} from './src/spotify';
import { artworkFilename, saveArtwork, SaveError } from './src/saveArtwork';

const background = require('./assets/background.jpg');
const logo = require('./assets/logo.png');
const loader = require('./assets/looking.gif');
const downloadIcon = require('./assets/download.png');

const RED = '#FF0000';
const SUGGESTION_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const MIN_TILE_WIDTH = 170;
const GRID_PADDING = 10;
const BLUR_RADIUS = 24;
// Laid over the blur so white text stays readable on pale artwork.
const GLASS_TINT = 'rgba(0, 0, 0, 0.45)';

function messageFor(err) {
  return err instanceof SpotifyError || err instanceof SaveError
    ? err.message
    : 'Something went wrong. Try again.';
}

// Tracks where a view sits on screen. Call measure from an onLayout that is known to
// fire, including one on an ancestor: moving a parent doesn't relayout its children.
function useWindowOffset() {
  const ref = useRef(null);
  const [offset, setOffset] = useState(null);

  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y) => {
      setOffset((prev) => (prev?.x === x && prev?.y === y ? prev : { x, y }));
    });
  }, []);

  return { ref, offset, measure };
}

// A blurred copy of the app background, shifted so it lines up with the real one and
// makes the parent look like frosted glass. The parent has to clip its overflow.
function GlassBackdrop({ offset }) {
  const { width, height } = useWindowDimensions();

  if (!offset) return null;

  return (
    <Image
      source={background}
      style={[styles.glassBackdrop, { width, height, left: -offset.x, top: -offset.y }]}
      contentFit="cover"
      blurRadius={BLUR_RADIUS}
    />
  );
}

function AlbumTile({ album, size, onSave, saving }) {
  const artwork = largestImage(album);

  return (
    <View style={[styles.tile, { width: size }]}>
      {artwork ? (
        <Image
          source={artwork}
          style={[styles.artwork, { width: size, height: size }]}
          contentFit="cover"
          transition={200}
        />
      ) : (
        <View style={[styles.artwork, styles.artworkMissing, { width: size, height: size }]}>
          <Text style={styles.artworkMissingText}>No cover</Text>
        </View>
      )}

      <View style={styles.caption}>
        {artwork && (
          // A blurred copy of the cover, aligned with the original so the strip reads as glass.
          <Image
            source={artwork}
            style={[styles.captionBlur, { width: size, height: size }]}
            contentFit="cover"
            blurRadius={BLUR_RADIUS}
          />
        )}

        <View style={styles.captionRow}>
          <Text style={styles.captionText} numberOfLines={2}>
            {album.name}
          </Text>
          <Pressable
            onPress={onSave}
            disabled={saving || !artwork}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Save cover for ${album.name}`}
            style={({ pressed }) => [styles.saveButton, pressed && styles.saveButtonPressed]}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Image source={downloadIcon} style={styles.saveIcon} contentFit="contain" />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Lookups() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const [query, setQuery] = useState('');
  const [albums, setAlbums] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  // Guards against a slow suggestion response overwriting a newer one.
  const suggestionRequestId = useRef(0);
  const debounceTimer = useRef(null);

  const searchBar = useWindowOffset();
  const dropdown = useWindowOffset();

  const measureGlass = useCallback(() => {
    searchBar.measure();
    dropdown.measure();
  }, [searchBar.measure, dropdown.measure]);

  const usableWidth = width - GRID_PADDING * 2;
  const columns = Math.max(2, Math.floor(usableWidth / MIN_TILE_WIDTH));
  const tileSize = usableWidth / columns;

  // Focusing the field lifts the header so the keyboard can't crowd the suggestions.
  const centerHeader = !hasSearched && !searchFocused;

  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const loadSuggestions = useCallback(async (text) => {
    const requestId = ++suggestionRequestId.current;

    try {
      const results = await searchArtists(text, 5);
      if (requestId !== suggestionRequestId.current) return;
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
    } catch {
      if (requestId !== suggestionRequestId.current) return;
      // A failed autocomplete shouldn't interrupt what the user is typing.
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, []);

  const handleChange = useCallback(
    (text) => {
      setQuery(text);
      clearTimeout(debounceTimer.current);

      if (text.trim().length < MIN_QUERY_LENGTH) {
        suggestionRequestId.current++;
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }

      debounceTimer.current = setTimeout(() => loadSuggestions(text.trim()), SUGGESTION_DEBOUNCE_MS);
    },
    [loadSuggestions]
  );

  const dismissSuggestions = useCallback(() => {
    clearTimeout(debounceTimer.current);
    suggestionRequestId.current++;
    setSuggestions([]);
    setShowSuggestions(false);
  }, []);

  const showArtist = useCallback(
    async (artist) => {
      dismissSuggestions();
      Keyboard.dismiss();
      setQuery(artist.name);
      setLoading(true);
      setError(null);
      setHasSearched(true);

      try {
        setAlbums(await getArtistAlbums(artist.id));
      } catch (err) {
        setAlbums([]);
        setError(messageFor(err));
      } finally {
        setLoading(false);
      }
    },
    [dismissSuggestions]
  );

  const submitSearch = useCallback(async () => {
    const text = query.trim();
    if (!text) return;

    dismissSuggestions();
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const { albums: found } = await searchTopArtistAlbums(text);
      setAlbums(found);
    } catch (err) {
      setAlbums([]);
      setError(messageFor(err));
    } finally {
      setLoading(false);
    }
  }, [query, dismissSuggestions]);

  const reset = useCallback(() => {
    dismissSuggestions();
    Keyboard.dismiss();
    setQuery('');
    setAlbums([]);
    setError(null);
    setHasSearched(false);
  }, [dismissSuggestions]);

  const handleSave = useCallback(async (album) => {
    const url = largestImage(album);
    if (!url) return;

    setSavingId(album.id);
    try {
      await saveArtwork(url, artworkFilename(album.name));
      Alert.alert('Saved', `"${album.name}" cover was added to your photos.`);
    } catch (err) {
      Alert.alert('Could not save', messageFor(err));
    } finally {
      setSavingId(null);
    }
  }, []);

  return (
    <ImageBackground source={background} style={styles.background} resizeMode="cover">
      <StatusBar style="light" />

      <View
        onLayout={measureGlass}
        style={[
          styles.headerArea,
          centerHeader ? styles.headerAreaCentered : { paddingTop: insets.top + 12 },
        ]}
      >
        <View style={styles.header}>
          <Pressable onPress={reset} accessibilityRole="button" accessibilityLabel="Reset search">
            <Image source={logo} style={styles.logo} contentFit="contain" />
          </Pressable>

          <View ref={searchBar.ref} onLayout={searchBar.measure} style={styles.searchBar}>
            <GlassBackdrop offset={searchBar.offset} />

            <TextInput
              style={styles.input}
              value={query}
              onChangeText={handleChange}
              onSubmitEditing={submitSearch}
              onFocus={() => {
                setSearchFocused(true);
                setShowSuggestions(suggestions.length > 0);
              }}
              onBlur={() => setSearchFocused(false)}
              placeholder="search music artists"
              placeholderTextColor="rgba(255, 255, 255, 0.7)"
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>

          {showSuggestions && (
            <View ref={dropdown.ref} onLayout={dropdown.measure} style={styles.suggestions}>
              <GlassBackdrop offset={dropdown.offset} />

              {suggestions.map((artist, index) => (
                <Pressable
                  key={artist.id}
                  onPress={() => showArtist(artist)}
                  style={({ pressed }) => [
                    styles.suggestion,
                    index < suggestions.length - 1 && styles.suggestionDivider,
                    pressed && styles.suggestionPressed,
                  ]}
                >
                  <Text style={styles.suggestionText}>{artist.name}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {loading && (
        <View style={styles.loader}>
          <Image source={loader} style={styles.loaderImage} contentFit="contain" />
        </View>
      )}

      {/* A list grows to fill space, so leaving it mounted would push the centered header upwards. */}
      {!loading && !centerHeader && (
        <FlatList
          key={columns}
          data={albums}
          keyExtractor={(album, index) => album.id ?? String(index)}
          numColumns={columns}
          renderItem={({ item }) => (
            <AlbumTile
              album={item}
              size={tileSize}
              saving={savingId === item.id}
              onSave={() => handleSave(item)}
            />
          )}
          contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={dismissSuggestions}
        />
      )}
    </ImageBackground>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Lookups />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  background: {
    flex: 1,
    backgroundColor: '#000000',
  },
  headerArea: {
    // Keeps the suggestion dropdown above the album grid.
    zIndex: 10,
  },
  headerAreaCentered: {
    flex: 1,
    justifyContent: 'center',
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    alignItems: 'center',
  },
  logo: {
    width: 180,
    height: 70,
  },
  searchBar: {
    marginTop: 12,
    width: '100%',
    maxWidth: 420,
    borderRadius: 4,
    // Clips the oversized blurred backdrop down to the bar.
    overflow: 'hidden',
  },
  glassBackdrop: {
    position: 'absolute',
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#FFFFFF',
    backgroundColor: GLASS_TINT,
  },
  suggestions: {
    position: 'absolute',
    top: '100%',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
    marginHorizontal: 20,
    borderRadius: 4,
    // Clips the oversized blurred backdrop down to the panel.
    overflow: 'hidden',
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  suggestion: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: GLASS_TINT,
  },
  suggestionDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.25)',
  },
  suggestionPressed: {
    backgroundColor: RED,
  },
  suggestionText: {
    fontSize: 16,
    color: '#FFFFFF',
  },
  errorBanner: {
    marginHorizontal: 20,
    marginBottom: 12,
    backgroundColor: 'rgba(220, 53, 69, 0.9)',
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  errorText: {
    color: '#FFFFFF',
    textAlign: 'center',
  },
  grid: {
    paddingHorizontal: GRID_PADDING,
    flexGrow: 1,
  },
  tile: {
    position: 'relative',
  },
  artwork: {
    backgroundColor: '#1A1A1A',
  },
  artworkMissing: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  artworkMissingText: {
    color: '#777777',
    fontSize: 12,
  },
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Clips the oversized blurred cover down to the strip.
    overflow: 'hidden',
  },
  captionBlur: {
    position: 'absolute',
    left: 0,
    bottom: 0,
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: GLASS_TINT,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  captionText: {
    flex: 1,
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 13,
  },
  saveButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonPressed: {
    transform: [{ scale: 1.2 }],
  },
  saveIcon: {
    width: 20,
    height: 20,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  loaderImage: {
    width: 140,
    height: 140,
  },
  empty: {
    marginTop: 40,
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 15,
    paddingHorizontal: 30,
  },
});
