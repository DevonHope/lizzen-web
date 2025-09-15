// Server-side torrent audio service using backend WebTorrent streaming

class TorrentAudioService {
  constructor() {
    this.audioCache = new Map();
    this.baseUrl = this.getApiBaseUrl();
  }

  getApiBaseUrl() {
    return window.location.hostname === 'localhost' 
      ? 'http://localhost:3001' 
      : `${window.location.protocol}//${window.location.host}`;
  }

  // Get audio stream URL from torrent via backend (with async support)
  async getAudioStreamUrl(magnetLink, fileName = null, expectedFileCount = null, useAsync = false) {
    try {
      if (!magnetLink) {
        throw new Error('No magnet link provided');
      }
      
      console.log('🏴‍☠️ Requesting torrent stream from backend:', magnetLink.substring(0, 50) + '...');
      
      // Check cache first
      const cacheKey = `${magnetLink}:${fileName || 'auto'}:${expectedFileCount || 'any'}`;
      if (this.audioCache.has(cacheKey)) {
        console.log('💾 Using cached stream URL');
        return this.audioCache.get(cacheKey);
      }

      // Request stream from backend
      const response = await fetch(`${this.baseUrl}/api/stream-torrent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          magnetLink: magnetLink,
          fileName: fileName,
          expectedFileCount: expectedFileCount,
          async: useAsync
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to get torrent stream');
      }

      const data = await response.json();
      
      // Handle async response
      if (data.async && data.jobId) {
        console.log('🚀 Started async stream preparation, job ID:', data.jobId);
        return await this.pollForStreamResults(data.jobId, cacheKey);
      }
      
      // Handle synchronous response
      if (data.success && data.streamUrl) {
        // Create full URL for streaming
        const fullStreamUrl = `${this.baseUrl}${data.streamUrl}`;
        
        console.log('✅ Got stream URL from backend:', data.fileName);
        
        // Cache the URL
        this.audioCache.set(cacheKey, fullStreamUrl);
        
        return fullStreamUrl;
      } else {
        throw new Error('No stream URL received from backend');
      }

    } catch (error) {
      console.error('❌ Error getting torrent stream:', error);
      throw error;
    }
  }

  // Poll for async stream preparation results
  async pollForStreamResults(jobId, cacheKey) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 18; // 3 minutes max
      
      const checkInterval = setInterval(async () => {
        attempts++;
        
        try {
          console.log(`🔍 Checking stream preparation job ${jobId} (attempt ${attempts}/${maxAttempts})...`);
          
          const response = await fetch(`${this.baseUrl}/api/job-status/${jobId}`);
          
          if (!response.ok) {
            console.warn('Failed to check stream job status');
            return;
          }
          
          const jobData = await response.json();
          
          if (jobData.status === 'completed' && jobData.result) {
            console.log('✅ Async stream preparation completed!');
            clearInterval(checkInterval);
            
            const result = jobData.result;
            
            if (result.success && result.streamUrl) {
              const fullStreamUrl = `${this.baseUrl}${result.streamUrl}`;
              console.log('✅ Got async stream URL:', result.fileName);
              
              // Cache the URL
              this.audioCache.set(cacheKey, fullStreamUrl);
              
              resolve(fullStreamUrl);
            } else {
              reject(new Error('No stream URL in async result'));
            }
            
          } else if (jobData.status === 'failed') {
            console.error('❌ Async stream preparation failed:', jobData.error);
            clearInterval(checkInterval);
            reject(new Error(jobData.error || 'Stream preparation failed'));
            
          } else if (attempts >= maxAttempts) {
            console.log('⏰ Stream preparation timeout');
            clearInterval(checkInterval);
            reject(new Error('Stream preparation timed out'));
          } else {
            if (jobData.progress) {
              console.log(`📊 Stream preparation progress: ${jobData.progress}%`);
            }
          }
        } catch (error) {
          console.error('Error checking stream job:', error);
          
          if (attempts >= maxAttempts) {
            clearInterval(checkInterval);
            reject(error);
          }
        }
      }, 10000); // Check every 10 seconds
    });
  }

  // Get MIME type for audio file
  getMimeType(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const mimeTypes = {
      'mp3': 'audio/mpeg',
      'flac': 'audio/flac',
      'wav': 'audio/wav',
      'm4a': 'audio/mp4',
      'aac': 'audio/aac',
      'ogg': 'audio/ogg',
      'wma': 'audio/x-ms-wma'
    };
    return mimeTypes[ext] || 'audio/mpeg';
  }

  // Clean up resources
  async cleanup() {
    // Clear local cache
    this.audioCache.clear();
    
    // Request backend cleanup
    try {
      await fetch(`${this.baseUrl}/api/cleanup-torrents`, {
        method: 'POST'
      });
      console.log('🧹 Backend torrents cleaned up');
    } catch (error) {
      console.error('❌ Error cleaning up backend torrents:', error);
    }
  }

  // Remove specific torrent
  removeTorrent(magnetLink) {
    // Clean up cached URLs for this torrent
    for (const [key, url] of this.audioCache.entries()) {
      if (key.startsWith(magnetLink)) {
        this.audioCache.delete(key);
      }
    }
  }

  // Get torrent progress (placeholder - could be implemented with WebSocket updates)
  getTorrentProgress(magnetLink) {
    return {
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0
    };
  }

  // Play specific track from album
  async playAlbumTrack(albumMagnetLink, options = {}) {
    try {
      if (!albumMagnetLink) {
        throw new Error('No album magnet link provided');
      }

      const { trackName, trackIndex, trackTitle, artistName } = options;
      
      console.log('🎵 Requesting album track from backend:', {
        albumMagnetLink: albumMagnetLink.substring(0, 50) + '...',
        trackName,
        trackIndex,
        trackTitle,
        artistName
      });

      // Request specific track from album
      const response = await fetch(`${this.baseUrl}/api/play-album-track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          albumMagnetLink,
          trackName,
          trackIndex,
          trackTitle,
          artistName
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to get album track stream');
      }

      const data = await response.json();
      
      if (data.success && data.streamUrl) {
        // Create full URL for streaming
        const fullStreamUrl = `${this.baseUrl}${data.streamUrl}`;
        
        console.log('✅ Got album track stream URL:', data.fileName);
        console.log('📁 Album:', data.albumName);
        console.log('🎵 Track:', `${data.trackIndex}/${data.totalTracks}`);
        
        // Return track information with stream URL
        return {
          streamUrl: fullStreamUrl,
          fileName: data.fileName,
          fileSize: data.fileSize,
          albumName: data.albumName,
          trackIndex: data.trackIndex,
          totalTracks: data.totalTracks,
          albumTracks: data.albumTracks
        };
      } else {
        throw new Error('No stream URL received from backend');
      }

    } catch (error) {
      console.error('❌ Error getting album track stream:', error);
      throw error;
    }
  }
}

// Create singleton instance
const torrentAudioService = new TorrentAudioService();

export default torrentAudioService;
