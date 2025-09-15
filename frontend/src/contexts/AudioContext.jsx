import React, { createContext, useContext, useReducer, useRef } from 'react';
import { Howl } from 'howler';
import torrentAudioService from '../services/TorrentAudioService';

const AudioContext = createContext();

// Audio player states
const AUDIO_STATES = {
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error'
};

// Initial state
const initialState = {
  currentTrack: null,
  queue: [],
  currentIndex: 0,
  state: AUDIO_STATES.IDLE,
  volume: 0.8,
  progress: 0,
  duration: 0,
  isRepeat: false,
  isShuffle: false
};

// Action types
const ACTIONS = {
  PLAY_TRACK: 'PLAY_TRACK',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOP',
  NEXT: 'NEXT',
  PREVIOUS: 'PREVIOUS',
  SET_VOLUME: 'SET_VOLUME',
  SET_PROGRESS: 'SET_PROGRESS',
  SET_DURATION: 'SET_DURATION',
  SET_STATE: 'SET_STATE',
  ADD_TO_QUEUE: 'ADD_TO_QUEUE',
  CLEAR_QUEUE: 'CLEAR_QUEUE',
  TOGGLE_REPEAT: 'TOGGLE_REPEAT',
  TOGGLE_SHUFFLE: 'TOGGLE_SHUFFLE',
  SET_QUEUE: 'SET_QUEUE'
};

// Reducer function
function audioReducer(state, action) {
  switch (action.type) {
    case ACTIONS.PLAY_TRACK:
      return {
        ...state,
        currentTrack: action.payload.track,
        queue: action.payload.queue || state.queue,
        currentIndex: action.payload.index !== undefined ? action.payload.index : state.currentIndex,
        state: AUDIO_STATES.LOADING
      };
    
    case ACTIONS.PAUSE:
      return { ...state, state: AUDIO_STATES.PAUSED };
    
    case ACTIONS.RESUME:
      return { ...state, state: AUDIO_STATES.PLAYING };
    
    case ACTIONS.STOP:
      return { ...state, state: AUDIO_STATES.IDLE, progress: 0 };
    
    case ACTIONS.SET_STATE:
      return { ...state, state: action.payload };
    
    case ACTIONS.SET_VOLUME:
      return { ...state, volume: action.payload };
    
    case ACTIONS.SET_PROGRESS:
      return { ...state, progress: action.payload };
    
    case ACTIONS.SET_DURATION:
      return { ...state, duration: action.payload };
    
    case ACTIONS.NEXT:
      const nextIndex = state.currentIndex + 1;
      if (nextIndex < state.queue.length) {
        return {
          ...state,
          currentIndex: nextIndex,
          currentTrack: state.queue[nextIndex],
          state: AUDIO_STATES.LOADING
        };
      }
      return state;
    
    case ACTIONS.PREVIOUS:
      const prevIndex = state.currentIndex - 1;
      if (prevIndex >= 0) {
        return {
          ...state,
          currentIndex: prevIndex,
          currentTrack: state.queue[prevIndex],
          state: AUDIO_STATES.LOADING
        };
      }
      return state;
    
    case ACTIONS.ADD_TO_QUEUE:
      return {
        ...state,
        queue: [...state.queue, action.payload]
      };
    
    case ACTIONS.SET_QUEUE:
      return {
        ...state,
        queue: action.payload,
        currentIndex: 0
      };
    
    case ACTIONS.CLEAR_QUEUE:
      return {
        ...state,
        queue: [],
        currentIndex: 0,
        currentTrack: null,
        state: AUDIO_STATES.IDLE
      };
    
    case ACTIONS.TOGGLE_REPEAT:
      return { ...state, isRepeat: !state.isRepeat };
    
    case ACTIONS.TOGGLE_SHUFFLE:
      return { ...state, isShuffle: !state.isShuffle };
    
    default:
      return state;
  }
}

// AudioProvider component
export function AudioProvider({ children }) {
  const [state, dispatch] = useReducer(audioReducer, initialState);
  const howlRef = useRef(null);
  const progressIntervalRef = useRef(null);

  // Play a track
  const playTrack = async (track, queue = null, index = 0) => {
    try {
      console.log('🎵 playTrack called with:', track);
      
      // Stop current track if playing
      if (howlRef.current) {
        howlRef.current.stop();
        howlRef.current.unload();
      }

      dispatch({
        type: ACTIONS.PLAY_TRACK,
        payload: { track, queue, index }
      });

      // For WebTorrent streams, we'll need to get the blob URL
      const audioUrl = track.audioUrl || track.streamUrl;
      
      console.log('🎵 Audio URL:', audioUrl);
      
      if (!audioUrl) {
        console.error('❌ No audio URL provided');
        dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
        return;
      }

      console.log('🎵 Creating Howl instance...');
      
      // Create new Howl instance
      howlRef.current = new Howl({
        src: [audioUrl],
        html5: true, // Use HTML5 audio for better streaming support
        volume: state.volume,
        onload: () => {
          console.log('🎵 Audio loaded successfully');
          dispatch({ type: ACTIONS.SET_DURATION, payload: howlRef.current.duration() });
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.PLAYING });
          startProgressTracking();
        },
        onplay: () => {
          console.log('🎵 Audio started playing');
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.PLAYING });
          startProgressTracking();
        },
        onpause: () => {
          console.log('🎵 Audio paused');
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.PAUSED });
          stopProgressTracking();
        },
        onstop: () => {
          console.log('🎵 Audio stopped');
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.IDLE });
          dispatch({ type: ACTIONS.SET_PROGRESS, payload: 0 });
          stopProgressTracking();
        },
        onend: () => {
          console.log('🎵 Audio ended');
          // Auto play next track if available
          if (state.isRepeat) {
            howlRef.current.play();
          } else {
            next();
          }
        },
        onloaderror: (id, error) => {
          console.error('❌ Audio load error:', error);
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
        },
        onplayerror: (id, error) => {
          console.error('❌ Audio play error:', error);
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
        }
      });

      console.log('🎵 Starting playback...');
      // Start playing
      howlRef.current.play();

    } catch (error) {
      console.error('❌ Error playing track:', error);
      dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
    }
  };

  // Start tracking progress
  const startProgressTracking = () => {
    stopProgressTracking(); // Clear any existing interval
    progressIntervalRef.current = setInterval(() => {
      if (howlRef.current && howlRef.current.playing()) {
        const seek = howlRef.current.seek();
        dispatch({ type: ACTIONS.SET_PROGRESS, payload: seek });
      }
    }, 1000);
  };

  // Stop tracking progress
  const stopProgressTracking = () => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  };

  // Control functions
  const pause = () => {
    if (howlRef.current) {
      howlRef.current.pause();
    }
  };

  const resume = () => {
    if (howlRef.current) {
      howlRef.current.play();
    }
  };

  const stop = () => {
    if (howlRef.current) {
      howlRef.current.stop();
    }
  };

  const setVolume = (volume) => {
    dispatch({ type: ACTIONS.SET_VOLUME, payload: volume });
    if (howlRef.current) {
      howlRef.current.volume(volume);
    }
  };

  const seek = (position) => {
    if (howlRef.current) {
      howlRef.current.seek(position);
      dispatch({ type: ACTIONS.SET_PROGRESS, payload: position });
    }
  };

  const next = async () => {
    if (state.currentIndex < state.queue.length - 1) {
      const nextTrack = state.queue[state.currentIndex + 1];
      
      // If it's an album track without a stream URL, get it dynamically
      if (nextTrack.isAlbumTrack && !nextTrack.audioUrl && nextTrack.albumMagnetLink) {
        try {
          console.log('🎵 Getting stream URL for next album track...');
          const trackInfo = await torrentAudioService.playAlbumTrack(nextTrack.albumMagnetLink, {
            trackName: nextTrack.fileName,
            trackIndex: nextTrack.trackIndex,
            trackTitle: nextTrack.title,
            artistName: nextTrack.artist
          });
          
          // Update the track with the stream URL
          nextTrack.audioUrl = trackInfo.streamUrl;
          nextTrack.streamUrl = trackInfo.streamUrl;
        } catch (error) {
          console.error('❌ Error getting next album track stream:', error);
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
          return;
        }
      }
      
      playTrack(nextTrack, state.queue, state.currentIndex + 1);
    }
  };

  const previous = async () => {
    if (state.currentIndex > 0) {
      const prevTrack = state.queue[state.currentIndex - 1];
      
      // If it's an album track without a stream URL, get it dynamically
      if (prevTrack.isAlbumTrack && !prevTrack.audioUrl && prevTrack.albumMagnetLink) {
        try {
          console.log('🎵 Getting stream URL for previous album track...');
          const trackInfo = await torrentAudioService.playAlbumTrack(prevTrack.albumMagnetLink, {
            trackName: prevTrack.fileName,
            trackIndex: prevTrack.trackIndex,
            trackTitle: prevTrack.title,
            artistName: prevTrack.artist
          });
          
          // Update the track with the stream URL
          prevTrack.audioUrl = trackInfo.streamUrl;
          prevTrack.streamUrl = trackInfo.streamUrl;
        } catch (error) {
          console.error('❌ Error getting previous album track stream:', error);
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
          return;
        }
      }
      
      playTrack(prevTrack, state.queue, state.currentIndex - 1);
    }
  };

  const addToQueue = (track) => {
    dispatch({ type: ACTIONS.ADD_TO_QUEUE, payload: track });
  };

  const setQueue = (queue) => {
    dispatch({ type: ACTIONS.SET_QUEUE, payload: queue });
  };

  const clearQueue = () => {
    stop();
    dispatch({ type: ACTIONS.CLEAR_QUEUE });
  };

  const toggleRepeat = () => {
    dispatch({ type: ACTIONS.TOGGLE_REPEAT });
  };

  const toggleShuffle = () => {
    dispatch({ type: ACTIONS.TOGGLE_SHUFFLE });
  };

  // Play specific track from album
  const playAlbumTrack = async (albumMagnetLink, options = {}) => {
    try {
      console.log('🎵 playAlbumTrack called with:', { albumMagnetLink: albumMagnetLink?.substring(0, 50) + '...', options });
      
      // Stop current track if playing
      if (howlRef.current) {
        howlRef.current.stop();
        howlRef.current.unload();
      }

      dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.LOADING });

      // Get the track stream from the album
      const trackInfo = await torrentAudioService.playAlbumTrack(albumMagnetLink, options);
      
      console.log('🎵 Got track info from album:', trackInfo);

      // Create track object with album context
      const track = {
        title: options.trackTitle || trackInfo.fileName,
        artist: options.artistName || 'Unknown Artist',
        album: trackInfo.albumName,
        audioUrl: trackInfo.streamUrl,
        streamUrl: trackInfo.streamUrl,
        fileName: trackInfo.fileName,
        fileSize: trackInfo.fileSize,
        trackIndex: trackInfo.trackIndex,
        totalTracks: trackInfo.totalTracks,
        albumMagnetLink: albumMagnetLink,
        isAlbumTrack: true
      };

      // Create queue from all album tracks if not provided
      let queue = [];
      if (trackInfo.albumTracks && trackInfo.albumTracks.length > 0) {
        queue = trackInfo.albumTracks.map((albumTrack, index) => ({
          title: albumTrack.name,
          artist: options.artistName || 'Unknown Artist',
          album: trackInfo.albumName,
          fileName: albumTrack.name,
          fileSize: albumTrack.size,
          trackIndex: albumTrack.index,
          totalTracks: trackInfo.totalTracks,
          albumMagnetLink: albumMagnetLink,
          isAlbumTrack: true,
          // Stream URL will be generated when this track is played
          audioUrl: null
        }));
      }

      // Find the current track index in the queue
      const currentIndex = trackInfo.trackIndex - 1; // Convert to 0-based index

      // Dispatch the track info
      dispatch({
        type: ACTIONS.PLAY_TRACK,
        payload: { track, queue, index: currentIndex }
      });

      console.log('🎵 Creating Howl instance for album track...');
      
      // Create new Howl instance
      howlRef.current = new Howl({
        src: [trackInfo.streamUrl],
        html5: true, // Use HTML5 audio for better streaming support
        volume: state.volume,
        onload: () => {
          console.log('🎵 Album track loaded successfully');
          dispatch({ type: ACTIONS.SET_DURATION, payload: howlRef.current.duration() });
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.PLAYING });
          startProgressTracking();
        },
        onplay: () => {
          console.log('🎵 Album track started playing');
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.PLAYING });
          startProgressTracking();
        },
        onpause: () => {
          console.log('🎵 Album track paused');
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.PAUSED });
          stopProgressTracking();
        },
        onstop: () => {
          console.log('🎵 Album track stopped');
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.IDLE });
          dispatch({ type: ACTIONS.SET_PROGRESS, payload: 0 });
          stopProgressTracking();
        },
        onend: () => {
          console.log('🎵 Album track ended');
          // Auto play next track if available
          if (state.isRepeat) {
            howlRef.current.play();
          } else {
            next();
          }
        },
        onloaderror: (id, error) => {
          console.error('❌ Album track load error:', error);
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
        },
        onplayerror: (id, error) => {
          console.error('❌ Album track play error:', error);
          dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
        }
      });

      console.log('🎵 Starting album track playback...');
      // Start playing
      howlRef.current.play();

    } catch (error) {
      console.error('❌ Error playing album track:', error);
      dispatch({ type: ACTIONS.SET_STATE, payload: AUDIO_STATES.ERROR });
    }
  };

  const value = {
    // State
    ...state,
    // Actions
    playTrack,
    playAlbumTrack,
    pause,
    resume,
    stop,
    next,
    previous,
    setVolume,
    seek,
    addToQueue,
    setQueue,
    clearQueue,
    toggleRepeat,
    toggleShuffle,
    // Constants
    AUDIO_STATES
  };

  return (
    <AudioContext.Provider value={value}>
      {children}
    </AudioContext.Provider>
  );
}

// Custom hook to use audio context
export function useAudio() {
  const context = useContext(AudioContext);
  if (!context) {
    throw new Error('useAudio must be used within an AudioProvider');
  }
  return context;
}

export { AUDIO_STATES };
