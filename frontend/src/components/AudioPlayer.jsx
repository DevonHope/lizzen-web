import React from 'react';
import { useAudio } from '../contexts/AudioContext';
import './AudioPlayer.css';

function AudioPlayer() {
  const {
    currentTrack,
    state,
    progress,
    duration,
    volume,
    isRepeat,
    isShuffle,
    pause,
    resume,
    stop,
    next,
    previous,
    setVolume,
    seek,
    toggleRepeat,
    toggleShuffle,
    AUDIO_STATES
  } = useAudio();

  console.log('🎵 AudioPlayer render - currentTrack:', currentTrack, 'state:', state);

  // Don't render if no track is loaded
  if (!currentTrack || state === AUDIO_STATES.IDLE) {
    console.log('🎵 AudioPlayer: Not rendering (no track or idle)');
    return null;
  }

  console.log('🎵 AudioPlayer: Rendering player');

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handlePlayPause = () => {
    if (state === AUDIO_STATES.PLAYING) {
      pause();
    } else if (state === AUDIO_STATES.PAUSED) {
      resume();
    }
  };

  const handleProgressChange = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const newTime = percent * duration;
    seek(newTime);
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
  };

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="audio-player">
      <div className="audio-player-content">
        {/* Track Info */}
        <div className="track-info">
          <div className="track-title">{currentTrack.title || currentTrack.name}</div>
          <div className="track-artist">
            {currentTrack.artist || currentTrack.albumArtist || 'Unknown Artist'}
          </div>
        </div>

        {/* Controls */}
        <div className="audio-controls">
          <button 
            className="control-btn"
            onClick={previous}
            disabled={!previous}
          >
            ⏮️
          </button>
          
          <button 
            className="control-btn play-pause-btn"
            onClick={handlePlayPause}
            disabled={state === AUDIO_STATES.LOADING || state === AUDIO_STATES.ERROR}
          >
            {state === AUDIO_STATES.LOADING ? (
              <div className="loading-spinner">⏳</div>
            ) : state === AUDIO_STATES.PLAYING ? (
              '⏸️'
            ) : (
              '▶️'
            )}
          </button>
          
          <button 
            className="control-btn"
            onClick={next}
            disabled={!next}
          >
            ⏭️
          </button>
          
          <button 
            className={`control-btn ${isRepeat ? 'active' : ''}`}
            onClick={toggleRepeat}
          >
            🔁
          </button>
          
          <button 
            className={`control-btn ${isShuffle ? 'active' : ''}`}
            onClick={toggleShuffle}
          >
            🔀
          </button>
        </div>

        {/* Progress Bar */}
        <div className="progress-section">
          <span className="time-display">{formatTime(progress)}</span>
          <div 
            className="progress-bar"
            onClick={handleProgressChange}
          >
            <div className="progress-track">
              <div 
                className="progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
          <span className="time-display">{formatTime(duration)}</span>
        </div>

        {/* Volume Control */}
        <div className="volume-section">
          <span className="volume-icon">🔊</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolumeChange}
            className="volume-slider"
          />
        </div>

        {/* Close Button */}
        <button className="close-btn" onClick={stop}>
          ✕
        </button>
      </div>

      {/* Error State */}
      {state === AUDIO_STATES.ERROR && (
        <div className="error-message">
          Failed to load audio. Please try again.
        </div>
      )}
    </div>
  );
}

export default AudioPlayer;
