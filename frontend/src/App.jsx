
import { useState } from 'react';
import { AudioProvider, useAudio } from './contexts/AudioContext';
import AudioPlayer from './components/AudioPlayer';
import torrentAudioService from './services/TorrentAudioService';
import './App.css';

function App() {
  return (
    <AudioProvider>
      <AppContent />
      <AudioPlayer />
    </AudioProvider>
  );
}

function AppContent() {
  const { playTrack } = useAudio();
  
  // Play audio from torrent
  const playTorrentAudio = async (torrent, item, expectedFileCount = null, trackName = null) => {
    try {
      console.log('🏴‍☠️ Playing torrent:', torrent.title);
      console.log('🔍 Torrent object:', torrent); // Debug log to see the structure
      console.log('🎯 Expected file count:', expectedFileCount);
      console.log('🎵 Track name:', trackName);
      
      // First, check if WebTorrent service is healthy
      console.log('🩺 Checking WebTorrent service health...');
      try {
        const healthResponse = await fetch(`${getApiBaseUrl()}/api/health`);
        const healthData = await healthResponse.json();
        console.log('🩺 WebTorrent health:', healthData.services.webTorrent);
        
        if (!healthData.services.webTorrent.isReady) {
          alert('WebTorrent service is not ready. Please try again in a moment.');
          return;
        }
      } catch (healthError) {
        console.warn('⚠️ Could not check WebTorrent health:', healthError);
        // Continue anyway, but warn user
      }
      
      // Handle different possible property names for the magnet link
      // Check if we have a pre-resolved magnet URL first (from pre-loaded torrents)
      const magnetLink = torrent.magnetUrl || torrent.url || torrent.magnetUrl || torrent.magnet || torrent.downloadUrl || torrent.link;
      
      if (!magnetLink) {
        console.error('❌ No magnet link found in torrent object');
        alert('This torrent does not have a valid download link.');
        return;
      }

      console.log('🧲 Using magnet link:', magnetLink.substring(0, 50) + '...');
      
      // Check if we already have a resolved magnet URL (from pre-loading)
      let resolvedMagnetLink = magnetLink;
      
      if (torrent.webTorrentReady && torrent.magnetUrl && torrent.magnetUrl.startsWith('magnet:')) {
        // Use pre-resolved magnet URL from album pre-loading
        resolvedMagnetLink = torrent.magnetUrl;
        console.log('🚀 Using pre-resolved magnet URL from album pre-loading');
      } else {
        // First resolve the URL to get the actual magnet link (if it's a Prowlarr download URL)
        console.log('🔗 Resolving URL to magnet link...');
        
        // If it's not already a magnet link, try to resolve it through the backend
        if (!magnetLink.startsWith('magnet:')) {
          try {
            console.log('🔄 URL is not a magnet link, resolving through backend...');
            const resolveResponse = await fetch(`${getApiBaseUrl()}/api/resolve-magnet`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ downloadUrl: magnetLink })
            });
            
            if (resolveResponse.ok) {
              const resolveResult = await resolveResponse.json();
              if (resolveResult.success && resolveResult.magnetUrl) {
                resolvedMagnetLink = resolveResult.magnetUrl;
                console.log(`✅ Resolved to magnet link: ${resolvedMagnetLink.substring(0, 60)}...`);
              } else {
                console.warn('⚠️ Could not resolve download URL to magnet link:', resolveResult.error);
              }
            }
          } catch (resolveError) {
            console.warn('⚠️ Error resolving download URL:', resolveError);
          }
        }
      }      // Test the resolved magnet link before proceeding (skip if pre-loaded)
      if (!torrent.webTorrentReady) {
        console.log('🧪 Testing resolved magnet link validity...');
        try {
          const testResponse = await fetch(`${getApiBaseUrl()}/api/test-magnet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ magnetLink: resolvedMagnetLink })
          });
          
          // Set a 8 second timeout for the test request itself
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Test request timed out')), 8000)
          );
          
          const testResult = await Promise.race([testResponse.json(), timeoutPromise]);
          console.log('🧪 Magnet test result:', testResult);
          
          if (!testResult.success) {
            console.error('❌ Magnet link test failed:', testResult.error);
            const continueAnyway = confirm(`Magnet link test failed: ${testResult.error}\n\nThis torrent may not have any active peers or the link may be invalid.\n\nDo you want to try streaming anyway?`);
            if (!continueAnyway) return;
          } else {
            console.log(`✅ Magnet link is valid: ${testResult.name} (${testResult.files} files)`);
          }
        } catch (testError) {
          console.warn('⚠️ Could not test magnet link:', testError);
          // Continue anyway but warn user
          const continueAnyway = confirm(`Could not verify magnet link: ${testError.message}\n\nThe test may have timed out. Do you want to try streaming anyway?`);
          if (!continueAnyway) return;
        }
      } else {
        console.log('🚀 Skipping magnet test for pre-loaded torrent');
      }
      
      // Display magnet link on the webpage for debugging
      const magnetDisplay = document.createElement('div');
      magnetDisplay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #1a1a1a;
        color: #fff;
        padding: 15px;
        border-radius: 8px;
        max-width: 400px;
        z-index: 10000;
        border: 2px solid #646cff;
        font-family: monospace;
        font-size: 12px;
        word-break: break-all;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      `;
      magnetDisplay.innerHTML = `
        <div style="color: #646cff; font-weight: bold; margin-bottom: 8px;">
          🧲 Streaming Torrent
        </div>
        <div style="margin-bottom: 8px;">
          <strong>Title:</strong> ${torrent.title || 'Unknown'}
        </div>
        <div style="margin-bottom: 8px;">
          <strong>Size:</strong> ${torrent.size || 'Unknown'}
        </div>
        <div style="margin-bottom: 8px;">
          <strong>Seeders:</strong> ${torrent.seeders || 'Unknown'}
        </div>
        <div style="margin-bottom: 8px;">
          <strong>🎯 Resolved Magnet Link:</strong>
        </div>
        <div style="background: #333; padding: 8px; border-radius: 4px; margin-bottom: 8px; max-height: 60px; overflow-y: auto; font-size: 10px;">
          ${resolvedMagnetLink}
        </div>
        ${resolvedMagnetLink !== magnetLink ? `
        <div style="margin-bottom: 8px;">
          <strong>📎 Original URL:</strong>
        </div>
        <div style="background: #444; padding: 8px; border-radius: 4px; margin-bottom: 8px; max-height: 60px; overflow-y: auto; font-size: 10px; color: #ccc;">
          ${magnetLink}
        </div>
        ` : ''}
        <button onclick="this.parentElement.remove()" style="background: #ff4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">
          Close
        </button>
      `;
      document.body.appendChild(magnetDisplay);
      
      // Auto-remove after 10 seconds
      setTimeout(() => {
        if (magnetDisplay.parentElement) {
          magnetDisplay.remove();
        }
      }, 10000);
      
      // Get audio stream URL from torrent
      const audioUrl = await torrentAudioService.getAudioStreamUrl(
        resolvedMagnetLink, // Use the resolved magnet link instead of the original URL
        trackName || item.title || item.name, // Use specific track name if provided
        expectedFileCount
      );
      
      if (audioUrl) {
        console.log('✅ Got audio URL, creating track...');
        
        // Create track object for the audio player
        const track = {
          title: item.title || item.name,
          artist: item.artist || item.albumArtist || 'Unknown Artist',
          album: item.album || 'Unknown Album',
          audioUrl: audioUrl,
          torrentInfo: {
            magnetLink: resolvedMagnetLink, // Use resolved magnet link
            originalUrl: magnetLink !== resolvedMagnetLink ? magnetLink : null,
            torrentTitle: torrent.title,
            size: torrent.size,
            seeders: torrent.seeders
          }
        };
        
        console.log('🎵 Playing track from torrent:', track);
        
        // Play the track
        await playTrack(track);
      } else {
        console.log('❌ No audio URL available from torrent service');
        
        // Check if it's a "no peers" error
        if (error && error.message && error.message.includes('No active peers')) {
          alert(`This torrent appears to be dead (no active seeders).\n\n${error.message}\n\nTry selecting a different torrent with more seeders.`);
        } else {
          alert('Could not get audio stream from this torrent. Please try another torrent.');
        }
      }
    } catch (error) {
      console.error('❌ Error playing torrent audio:', error);
      
      // Provide more specific error messages
      if (error.message && error.message.includes('No active peers')) {
        alert(`This torrent appears to be dead (no active seeders).\n\n${error.message}\n\nTry selecting a different torrent with more seeders.`);
      } else if (error.message && error.message.includes('timeout')) {
        alert(`Torrent connection timed out.\n\n${error.message}\n\nThis torrent may have no active peers. Try a different torrent.`);
      } else {
        alert(`Failed to play audio from torrent: ${error.message}`);
      }
    }
  };

  // Play track from album (use pre-loaded torrents if available, otherwise find best torrent)
  const playTrackFromAlbum = async (track) => {
    console.log('🎵 Playing track from album:', track.title);
    
    // Define trackId at the beginning so it's available in all scopes
    const trackId = track.id || `${selectedAlbum.id}-${track.title}`;
    
    try {
      // Show loading state
      setLoadingTorrents(prev => ({ ...prev, [trackId]: true }));
      
      // Check if we have pre-loaded torrents for this album
      const preLoadedTorrents = selectedAlbum?.torrents;
      
      if (preLoadedTorrents && preLoadedTorrents.length > 0) {
        console.log('🚀 Using pre-loaded album torrents:', preLoadedTorrents.length);
        
        // Use the best torrent from pre-loaded list
        const bestTorrent = preLoadedTorrents[0]; // Already sorted by score
        console.log('✅ Using pre-loaded best torrent:', bestTorrent.title);
        console.log('� Score:', bestTorrent.score, 'Seeders:', bestTorrent.seeders);
        
        // Create track object for the audio player
        const trackSearchItem = {
          id: trackId,
          title: track.title,
          artist: selectedArtist?.name,
          albumArtist: selectedArtist?.name,
          album: selectedAlbum?.title
        };
        
        // For album torrents, pass the track title as fileName to help select the right track
        console.log(`🎯 Playing track "${track.title}" from album torrent`);
        
        // Determine expected file count (album track count for album torrents)
        const expectedFileCount = albumDetails?.tracks?.length || selectedAlbum?.trackCount || null;
        console.log('🎯 Expected file count for album torrent:', expectedFileCount);
        
        // Pass track title as fileName to help backend select the right track
        await playTorrentAudio(bestTorrent, trackSearchItem, expectedFileCount, track.title);
        
        // Store all pre-loaded torrents for display
        setTorrents(prev => ({ ...prev, [trackId]: preLoadedTorrents }));
        
      } else {
        console.log('🔍 No pre-loaded torrents, searching for best torrent...');
        
        console.log('�🎯 Finding best torrent for track...');
        console.log('📋 Full track object:', track);
        console.log('🆔 Track ID being sent as musicbrainzId:', track.id);
        console.log('🎵 Track title:', track.title);
        console.log('👤 Artist name:', selectedArtist?.name);
        console.log('💽 Album title:', selectedAlbum?.title);
        console.log('📊 Album object:', selectedAlbum);
        console.log('🎤 Artist object:', selectedArtist);
        
        // Call the smart torrent selection endpoint with async mode
        const response = await fetch(`${getApiBaseUrl()}/api/find-best-torrent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trackTitle: track.title,
            artistName: selectedArtist?.name,
            albumTitle: selectedAlbum?.title,
            async: true, // Enable async mode
            debug: {
              originalTrackId: track.id,
              fallbackTrackId: trackId,
              trackObject: track,
              note: 'Using async torrent search for better user experience'
            }
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to start torrent search');
        }
        
        const data = await response.json();
        
        if (data.async && data.jobId) {
          console.log('🚀 Started async torrent search, job ID:', data.jobId);
          
          // Show progress indicator and poll for results
          setTorrents(prev => ({ ...prev, [trackId]: 'searching' }));
          
          // Poll for results
          pollForTorrentSearchResults(data.jobId, trackId, track, trackSearchItem, expectedFileCount);
          
        } else {
          // Fallback to synchronous response
          if (data.success && data.bestTorrent) {
            console.log('✅ Found best torrent:', data.bestTorrent.title);
            
            await playTorrentAudio(data.bestTorrent, trackSearchItem, expectedFileCount);
            const allTorrents = [data.bestTorrent, ...(data.alternativeTorrents || [])];
            setTorrents(prev => ({ ...prev, [trackId]: allTorrents }));
          } else {
            console.log('❌ No suitable torrent found');
            alert(`No suitable torrents found for "${track.title}".\n\nReason: ${data.message || 'Unknown error'}`);
            setTorrents(prev => ({ ...prev, [trackId]: [] }));
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Error finding best torrent:', error);
      alert(`Failed to find torrent for "${track.title}": ${error.message}`);
      
      // Fallback to manual search
      console.log('🔄 Falling back to manual torrent search...');
      const trackSearchItem = {
        id: trackId, // Now trackId is properly defined
        title: track.title,
        artist: selectedArtist?.name,
        albumArtist: selectedArtist?.name,
        album: selectedAlbum?.title,
        'artist-credit': [{ name: selectedArtist?.name }]
      };
      await searchTorrents(trackSearchItem, 'recording');
      
    } finally {
      // Clear loading state
      setLoadingTorrents(prev => ({ ...prev, [trackId]: false }));
    }
  };
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingTorrents, setLoadingTorrents] = useState({});
  const [torrents, setTorrents] = useState({});
  const [loadingAlbums, setLoadingAlbums] = useState({});
  const [artistAlbums, setArtistAlbums] = useState({});
  const [artistImages, setArtistImages] = useState({});
  const [loadingImages, setLoadingImages] = useState({});
  
  // Artist page state
  const [currentView, setCurrentView] = useState('search'); // 'search', 'artist', or 'album'
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [artistDetails, setArtistDetails] = useState(null);
  const [loadingArtistDetails, setLoadingArtistDetails] = useState(false);
  const [previousSearchState, setPreviousSearchState] = useState(null);
  
  // Album page state
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [albumDetails, setAlbumDetails] = useState(null);
  const [loadingAlbumDetails, setLoadingAlbumDetails] = useState(false);
  const [previousArtistState, setPreviousArtistState] = useState(null);

  const getApiBaseUrl = () => {
    return window.location.hostname === 'localhost' 
      ? 'http://localhost:3001' 
      : `${window.location.protocol}//${window.location.host}`;
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setCategories(null);
    setTorrents({});
    setArtistAlbums({});
    setArtistImages({});
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('Failed to fetch results');
      const data = await response.json();
      setCategories(data.categories || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const searchArtistAlbums = async (artist) => {
    const artistId = artist.id;
    setLoadingAlbums(prev => ({ ...prev, [artistId]: true }));
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/artist-albums`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistId: artist.id, artistName: artist.name })
      });
      
      if (!response.ok) throw new Error('Failed to fetch albums');
      const data = await response.json();
      
      setArtistAlbums(prev => ({ ...prev, [artistId]: data.albums || [] }));
    } catch (err) {
      console.error('Error fetching albums:', err);
      setArtistAlbums(prev => ({ ...prev, [artistId]: [] }));
    } finally {
      setLoadingAlbums(prev => ({ ...prev, [artistId]: false }));
    }
  };

  // Navigate to artist page
  const viewArtistDetails = async (artist) => {
    console.log('Viewing artist details for:', artist);
    
    // Save current search state
    setPreviousSearchState({
      query,
      categories,
      torrents,
      artistAlbums,
      artistImages
    });
    
    setSelectedArtist(artist);
    setCurrentView('artist');
    setLoadingArtistDetails(true);
    
    try {
      // Fetch detailed artist information
      const response = await fetch(`${getApiBaseUrl()}/api/artist-details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistId: artist.id, artistName: artist.name })
      });
      
      if (!response.ok) throw new Error('Failed to fetch artist details');
      const data = await response.json();
      
      setArtistDetails(data);
      
      // If torrent pre-loading is in progress, check for pre-loaded torrents periodically
      if (data.torrentPreloadingInProgress) {
        console.log('🚀 Torrent pre-loading in progress, will check for updates...');
        checkForPreloadedTorrents(artist.id);
      }
    } catch (err) {
      console.error('Error fetching artist details:', err);
      setError('Failed to load artist details');
    } finally {
      setLoadingArtistDetails(false);
    }
  };

  // Check for pre-loaded torrents periodically
  const checkForPreloadedTorrents = async (artistId) => {
    let attempts = 0;
    const maxAttempts = 12; // Check for 2 minutes (every 10 seconds)
    
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        console.log(`🔍 Checking for pre-loaded torrents (attempt ${attempts}/${maxAttempts})...`);
        
        const response = await fetch(`${getApiBaseUrl()}/api/artist-torrents/${artistId}`);
        
        if (!response.ok) {
          console.warn('Failed to check for pre-loaded torrents');
          return;
        }
        
        const data = await response.json();
        
        if (data.success && data.albums) {
          console.log('✅ Pre-loaded torrents are ready!');
          console.log(`📀 Got torrents for ${data.albums.length} albums`);
          
          // Update artist details with pre-loaded torrents
          setArtistDetails(prev => {
            if (!prev) return prev;
            
            return {
              ...prev,
              albums: data.albums,
              releases: {
                ...prev.releases,
                albums: data.albums
              },
              torrentPreloadingInProgress: false,
              torrentPreloadingCompleted: true,
              torrentPreloadedAt: data.preloadedAt
            };
          });
          
          clearInterval(checkInterval);
        } else if (attempts >= maxAttempts) {
          console.log('⏰ Stopped checking for pre-loaded torrents after maximum attempts');
          clearInterval(checkInterval);
          
          // Update to indicate pre-loading is no longer in progress
          setArtistDetails(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              torrentPreloadingInProgress: false,
              torrentPreloadingTimedOut: true
            };
          });
        }
      } catch (error) {
        console.error('Error checking for pre-loaded torrents:', error);
        
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          setArtistDetails(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              torrentPreloadingInProgress: false,
              torrentPreloadingTimedOut: true
            };
          });
        }
      }
    }, 10000); // Check every 10 seconds
  };

  // Poll for async torrent search results
  const pollForTorrentSearchResults = async (jobId, trackId, track, trackSearchItem, expectedFileCount) => {
    let attempts = 0;
    const maxAttempts = 18; // Check for 3 minutes (every 10 seconds)
    
    const checkInterval = setInterval(async () => {
      attempts++;
      
      try {
        console.log(`🔍 Checking torrent search job ${jobId} (attempt ${attempts}/${maxAttempts})...`);
        
        const response = await fetch(`${getApiBaseUrl()}/api/job-status/${jobId}`);
        
        if (!response.ok) {
          console.warn('Failed to check job status');
          return;
        }
        
        const jobData = await response.json();
        
        if (jobData.status === 'completed' && jobData.result) {
          console.log('✅ Async torrent search completed!');
          clearInterval(checkInterval);
          
          const result = jobData.result;
          
          if (result.success && result.bestTorrent) {
            console.log('🏆 Found best torrent:', result.bestTorrent.title);
            console.log('🏆 Score:', result.bestTorrent.score, 'Seeders:', result.bestTorrent.seeders);
            
            // Play the torrent
            await playTorrentAudio(result.bestTorrent, trackSearchItem, expectedFileCount, track.title);
            
            // Store all torrents for display
            const allTorrents = [result.bestTorrent, ...(result.alternativeTorrents || [])];
            setTorrents(prev => ({ ...prev, [trackId]: allTorrents }));
          } else {
            console.log('❌ No suitable torrent found');
            alert(`No suitable torrents found for "${track.title}".\n\nReason: ${result.message || 'Unknown error'}`);
            setTorrents(prev => ({ ...prev, [trackId]: [] }));
          }
          
          setLoadingTorrents(prev => ({ ...prev, [trackId]: false }));
          
        } else if (jobData.status === 'failed') {
          console.error('❌ Async torrent search failed:', jobData.error);
          clearInterval(checkInterval);
          
          alert(`Torrent search failed for "${track.title}": ${jobData.error}`);
          setTorrents(prev => ({ ...prev, [trackId]: [] }));
          setLoadingTorrents(prev => ({ ...prev, [trackId]: false }));
          
        } else if (attempts >= maxAttempts) {
          console.log('⏰ Stopped checking for torrent search results after maximum attempts');
          clearInterval(checkInterval);
          
          alert(`Torrent search for "${track.title}" is taking too long. Please try again.`);
          setTorrents(prev => ({ ...prev, [trackId]: [] }));
          setLoadingTorrents(prev => ({ ...prev, [trackId]: false }));
        } else {
          // Update progress if available
          if (jobData.progress) {
            console.log(`📊 Torrent search progress: ${jobData.progress}%`);
          }
        }
      } catch (error) {
        console.error('Error checking torrent search job:', error);
        
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          setTorrents(prev => ({ ...prev, [trackId]: [] }));
          setLoadingTorrents(prev => ({ ...prev, [trackId]: false }));
        }
      }
    }, 10000); // Check every 10 seconds
  };

  // Go back to search results
  const goBackToSearch = () => {
    setCurrentView('search');
    setSelectedArtist(null);
    setArtistDetails(null);
    
    // Restore previous search state
    if (previousSearchState) {
      setCategories(previousSearchState.categories);
      setTorrents(previousSearchState.torrents);
      setArtistAlbums(previousSearchState.artistAlbums);
      setArtistImages(previousSearchState.artistImages);
    }
  };

  // Navigate to album page
  const viewAlbumDetails = async (album, artist) => {
    console.log('Viewing album details for:', album);
    
    // Save current artist state
    setPreviousArtistState({
      selectedArtist,
      artistDetails
    });
    
    setSelectedAlbum(album);
    setCurrentView('album');
    setLoadingAlbumDetails(true);
    
    try {
      // Fetch detailed album information
      const response = await fetch(`${getApiBaseUrl()}/api/album-details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          albumId: album.id, 
          albumTitle: album.title,
          artistName: artist?.name || selectedArtist?.name 
        })
      });
      
      if (!response.ok) throw new Error('Failed to fetch album details');
      const data = await response.json();
      
      setAlbumDetails(data);
    } catch (err) {
      console.error('Error fetching album details:', err);
      setError('Failed to load album details');
    } finally {
      setLoadingAlbumDetails(false);
    }
  };

  // Go back to artist page
  const goBackToArtist = () => {
    setCurrentView('artist');
    setSelectedAlbum(null);
    setAlbumDetails(null);
    
    // Restore previous artist state
    if (previousArtistState) {
      setSelectedArtist(previousArtistState.selectedArtist);
      setArtistDetails(previousArtistState.artistDetails);
    }
  };

  // Handle track click (for future implementation)
  const handleTrackClick = (track) => {
    console.log('Track clicked:', track);
    // Future: Could trigger torrent search for this specific track
  };

  const searchTorrents = async (item, type) => {
    const itemId = item.id;
    setLoadingTorrents(prev => ({ ...prev, [itemId]: true }));
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/search-torrents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ musicbrainzItem: item, type })
      });
      
      if (!response.ok) throw new Error('Failed to fetch torrents');
      const data = await response.json();
      
      setTorrents(prev => ({ ...prev, [itemId]: data.torrents || [] }));
    } catch (err) {
      console.error('Error fetching torrents:', err);
      setTorrents(prev => ({ ...prev, [itemId]: [] }));
    } finally {
      setLoadingTorrents(prev => ({ ...prev, [itemId]: false }));
    }
  };

  const fetchArtistImage = async (artist) => {
    const artistId = artist.id;
    if (loadingImages[artistId] || artistImages[artistId]) return;
    
    setLoadingImages(prev => ({ ...prev, [artistId]: true }));
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/artist-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistId: artist.id, artistName: artist.name })
      });
      
      if (response.ok) {
        const data = await response.json();
        setArtistImages(prev => ({ ...prev, [artistId]: data.imageUrl || null }));
      }
    } catch (err) {
      console.error('Error fetching artist image:', err);
    } finally {
      setLoadingImages(prev => ({ ...prev, [artistId]: false }));
    }
  };

  // Generate artist image URL - try real image first, then fallback to generated
  const getArtistImageUrl = (artist) => {
    const cachedImage = artistImages[artist.id];
    if (cachedImage) return cachedImage;
    
    // Fallback to generated avatar
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(artist.name)}&backgroundColor=646cff&textColor=ffffff`;
  };

  // Render artist as circle
  const renderArtistCircle = (artist) => {
    const isLoadingAlbums = loadingAlbums[artist.id];
    const albums = artistAlbums[artist.id] || [];
    const hasSearchedAlbums = artist.id in artistAlbums;
    const isLoadingImage = loadingImages[artist.id];

    // Trigger image fetch if not already loaded or loading
    if (!isLoadingImage && !artistImages[artist.id]) {
      fetchArtistImage(artist);
    }

    return (
      <div key={artist.id} style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        cursor: 'pointer',
        transition: 'transform 0.2s ease',
        ':hover': { transform: 'scale(1.05)' }
      }}
      onClick={() => viewArtistDetails(artist)}
      >
        {/* Artist Circle */}
        <div style={{
          width: 'min(100px, 18vw)',
          height: 'min(100px, 18vw)',
          minWidth: '70px',
          minHeight: '70px',
          borderRadius: '50%',
          backgroundImage: `url('${getArtistImageUrl(artist)}')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          border: '3px solid #646cff',
          marginBottom: 8,
          position: 'relative',
          overflow: 'hidden'
        }}>
          {/* Loading indicator for image */}
          {isLoadingImage && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'rgba(0,0,0,0.7)',
              color: '#fff',
              padding: '4px 8px',
              borderRadius: 4,
              fontSize: 10
            }}>
              Loading...
            </div>
          )}
          
          {/* Overlay for better text visibility */}
          <div style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
            padding: '8px 4px 4px',
            fontSize: 10,
            color: '#fff',
            textAlign: 'center',
            fontWeight: 'bold'
          }}>
            {artist.country && artist.country}
          </div>
        </div>
        
        {/* Artist Name */}
        <div style={{ 
          fontSize: 'min(14px, 3vw)', 
          fontWeight: 'bold', 
          color: '#fff', 
          textAlign: 'center',
          maxWidth: 'min(100px, 18vw)',
          minWidth: '70px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: 4
        }}>
          {artist.name}
        </div>
        
        {/* Artist Info */}
        <div style={{ 
          fontSize: 'min(11px, 2.5vw)', 
          color: '#ccc', 
          textAlign: 'center',
          maxWidth: 'min(100px, 18vw)',
          minWidth: '70px'
        }}>
          {artist.type || 'Artist'}
        </div>

        {/* Loading/Albums Status */}
        {isLoadingAlbums && (
          <div style={{ fontSize: 'min(10px, 2vw)', color: '#646cff', marginTop: 4 }}>
            Loading albums...
          </div>
        )}
        {hasSearchedAlbums && (
          <div style={{ fontSize: 'min(10px, 2vw)', color: '#ff6b6b', marginTop: 4 }}>
            {albums.length} albums
          </div>
        )}
      </div>
    );
  };

  // Render artists grid (2x4)
  const renderArtistsGrid = (artists) => {
    if (!artists || artists.length === 0) return null;

    return (
      <div style={{ marginBottom: 40, width: '100%' }}>
        <h2 style={{ 
          color: '#fff', 
          borderBottom: '2px solid #646cff', 
          paddingBottom: 8,
          marginBottom: 20,
          textAlign: 'center',
          maxWidth: '600px',
          margin: '0 auto 20px auto'
        }}>
          🎤 Artists ({artists.length})
        </h2>
        
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(85px, 1fr))',
          gap: 12,
          maxWidth: '600px',
          width: '100%',
          margin: '0 auto',
          padding: '0 10px',
          justifyItems: 'center'
        }}>
          {artists.slice(0, 10).map(artist => renderArtistCircle(artist))}
        </div>
        
        {artists.length > 10 && (
          <div style={{ 
            textAlign: 'center', 
            marginTop: 16, 
            color: '#888',
            fontSize: 14
          }}>
            + {artists.length - 10} more artists
          </div>
        )}
      </div>
    );
  };

  // Render songs and albums as cards
  const renderMusicBrainzItem = (item, type) => {
    const itemId = item.id;
    const isLoadingTorrents = loadingTorrents[itemId];
    const itemTorrents = torrents[itemId] || [];
    const hasSearchedTorrents = itemId in torrents;

    return (
      <div key={itemId} style={{ 
        background: '#333', 
        padding: 'min(16px, 4vw)', 
        borderRadius: 8,
        border: '1px solid #555',
        marginBottom: 16,
        width: '100%',
        maxWidth: '600px',
        boxSizing: 'border-box'
      }}>
        {/* MusicBrainz Item Info */}
        <div style={{ marginBottom: 12 }}>
          {type === 'recording' && (
            <>
              <div style={{ 
                fontSize: 'clamp(16px, 4vw, 18px)', 
                fontWeight: 'bold', 
                color: '#fff', 
                marginBottom: 4,
                wordWrap: 'break-word'
              }}>
                🎵 {item.title}
              </div>
              <div style={{ 
                color: '#ccc', 
                marginBottom: 8,
                fontSize: 'clamp(12px, 3vw, 14px)',
                wordWrap: 'break-word'
              }}>
                by {item['artist-credit']?.[0]?.name || 'Unknown Artist'}
                {item.length && ` • ${Math.round(item.length / 1000)}s`}
              </div>
            </>
          )}
          
          {type === 'release' && (
            <>
              <div style={{ 
                fontSize: 'clamp(16px, 4vw, 18px)', 
                fontWeight: 'bold', 
                color: '#fff', 
                marginBottom: 4,
                wordWrap: 'break-word'
              }}>
                💿 {item.title}
              </div>
              <div style={{ 
                color: '#ccc', 
                marginBottom: 8,
                fontSize: 'clamp(12px, 3vw, 14px)',
                wordWrap: 'break-word'
              }}>
                by {item['artist-credit']?.[0]?.name || 'Unknown Artist'}
                {item.date && ` • ${item.date}`}
                {item.status && ` • ${item.status}`}
              </div>
            </>
          )}
          
          <div style={{ 
            fontSize: 'clamp(10px, 2.5vw, 12px)', 
            color: '#888',
            wordWrap: 'break-word'
          }}>
            MusicBrainz ID: {item.id}
          </div>
        </div>

        {/* Search Torrents Button */}
        {!hasSearchedTorrents && (
          <button
            onClick={() => searchTorrents(item, type)}
            disabled={isLoadingTorrents}
            style={{
              padding: '8px 16px',
              background: '#646cff',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: isLoadingTorrents ? 'not-allowed' : 'pointer',
              opacity: isLoadingTorrents ? 0.6 : 1,
              fontSize: 'clamp(12px, 3vw, 14px)',
              width: '100%',
              maxWidth: '200px'
            }}
          >
            {isLoadingTorrents ? 'Searching...' : '🏴‍☠️ Find Torrents'}
          </button>
        )}

        {/* Torrent Results */}
        {hasSearchedTorrents && (
          <div style={{ marginTop: 16 }}>
            {itemTorrents.length > 0 ? (
              <>
                <div style={{ 
                  color: '#646cff', 
                  fontWeight: 'bold', 
                  marginBottom: 12,
                  fontSize: 'clamp(12px, 3vw, 14px)'
                }}>
                  🏴‍☠️ Found {itemTorrents.length} Torrents:
                </div>
                <div style={{ display: 'grid', gap: 12 }}>
                  {itemTorrents.slice(0, 5).map((torrent, idx) => (
                    <div key={idx} style={{ 
                      background: '#2a2a2a', 
                      padding: 'min(12px, 3vw)', 
                      borderRadius: 6,
                      border: '1px solid #555',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}>
                      <div style={{ 
                        fontSize: 'clamp(12px, 3vw, 14px)', 
                        fontWeight: 'bold', 
                        color: '#fff', 
                        marginBottom: 6,
                        wordWrap: 'break-word'
                      }}>
                        {torrent.title}
                      </div>
                      <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', 
                        gap: 6, 
                        fontSize: 'clamp(10px, 2.5vw, 12px)', 
                        marginBottom: 8 
                      }}>
                        <div><strong>Size:</strong> {torrent.size}</div>
                        <div><strong>Seeders:</strong> {torrent.seeders}</div>
                        <div><strong>Leechers:</strong> {torrent.leechers}</div>
                        <div><strong>Indexer:</strong> {torrent.indexer}</div>
                      </div>
                      
                      {/* URL Debug Section */}
                      <details style={{ marginBottom: 8, fontSize: 'clamp(9px, 2vw, 10px)' }}>
                        <summary style={{ cursor: 'pointer', color: '#646cff' }}>🔍 Magnet Link Status</summary>
                        <div style={{ marginTop: 4, padding: 4, background: '#222', borderRadius: 4 }}>
                          <div>
                            <strong style={{ color: torrent.url?.startsWith('magnet:') ? '#4ade80' : '#fbbf24' }}>
                              {torrent.url?.startsWith('magnet:') ? '🧲 Valid Magnet Link' : '🔗 Prowlarr Download URL (will be resolved)'}
                            </strong>
                            <div style={{ wordBreak: 'break-all', background: torrent.url?.startsWith('magnet:') ? '#003300' : '#333300', padding: 2, borderRadius: 2, fontSize: 8 }}>
                              {torrent.url?.startsWith('magnet:') ? 
                                torrent.url.substring(0, 100) + '...' : 
                                torrent.url
                              }
                            </div>
                          </div>
                        </div>
                      </details>
                      <div style={{ 
                        display: 'flex', 
                        gap: 8, 
                        alignItems: 'center',
                        marginTop: 8
                      }}>
                        {/* Play Button */}
                        <button
                          onClick={() => playTorrentAudio(torrent, item, 1)} // Single track context
                          style={{
                            background: '#1db954',
                            color: '#fff',
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 'clamp(10px, 2.5vw, 12px)',
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4
                          }}
                        >
                          ▶️ Stream
                        </button>
                        
                        {/* Test Audio Player Button */}
                        <button
                          onClick={() => {
                            console.log('🔔 Test Audio button clicked!');
                            // Test the audio player with a sample audio file
                            const testTrack = {
                              title: item.title || item.name,
                              artist: item.artist || item.albumArtist || 'Unknown Artist',
                              album: item.album || 'Unknown Album',
                              audioUrl: 'https://www.soundjay.com/misc/sounds/bell-ringing-05.wav'
                            };
                            console.log('🔔 Calling playTrack with:', testTrack);
                            playTrack(testTrack);
                          }}
                          style={{
                            background: '#ff6b35',
                            color: '#fff',
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 'clamp(10px, 2.5vw, 12px)',
                            fontWeight: 'bold',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4
                          }}
                        >
                          🔔 Test Audio
                        </button>
                        
                        {/* Download Link */}
                        {torrent.url && torrent.url !== '#' && (
                          <a 
                            href={torrent.url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            style={{ 
                              color: '#646cff', 
                              textDecoration: 'none',
                              padding: '6px 12px',
                              background: '#444',
                              borderRadius: 4,
                              fontSize: 'clamp(10px, 2.5vw, 12px)',
                              display: 'inline-block'
                            }}
                          >
                            Download
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ 
                color: '#888', 
                fontStyle: 'italic',
                fontSize: 'clamp(12px, 3vw, 14px)'
              }}>
                No torrents found for this item
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderCategory = (category, type) => {
    if (!category.results || category.results.length === 0) return null;

    // Special handling for artists - render as grid circles
    if (type === 'artist') {
      return renderArtistsGrid(category.results);
    }

    // Regular rendering for songs and albums
    return (
      <div key={type} style={{ marginBottom: 32, width: '100%', maxWidth: '800px' }}>
        <h2 style={{ 
          color: '#fff', 
          borderBottom: '2px solid #646cff', 
          paddingBottom: 8,
          marginBottom: 16,
          textAlign: 'center'
        }}>
          {category.title} ({category.count})
        </h2>
        
        <div style={{ 
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          alignItems: 'center'
        }}>
          {category.results.map(item => renderMusicBrainzItem(item, type))}
        </div>
      </div>
    );
  };

  // Helper function to render a release section
  const renderReleaseSection = (releases, title, emoji) => {
    if (!releases || releases.length === 0) return null;

    return (
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ 
          fontSize: 'clamp(20px, 4vw, 28px)',
          marginBottom: '20px',
          color: '#646cff'
        }}>
          {emoji} {title} ({releases.length})
        </h2>
        
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: '20px'
        }}>
          {releases.map((release, index) => {
            // Check torrent status
            const hasTorrents = release.torrents && release.torrents.length > 0;
            const isDownloaded = hasTorrents && release.torrents.some(torrent => torrent.webTorrentReady === true);
            const isQueued = hasTorrents && !isDownloaded;
            
            return (
              <div key={`${release.id}-${index}`} style={{
                background: 'rgba(255,255,255,0.1)',
                borderRadius: '12px',
                padding: '16px',
                transition: 'transform 0.2s ease, background 0.2s ease',
                cursor: 'pointer',
                position: 'relative'
              }}
              onClick={() => viewAlbumDetails(release, selectedArtist)}
              onMouseEnter={(e) => {
                e.target.style.transform = 'translateY(-4px)';
                e.target.style.background = 'rgba(255,255,255,0.15)';
              }}
              onMouseLeave={(e) => {
                e.target.style.transform = 'translateY(0)';
                e.target.style.background = 'rgba(255,255,255,0.1)';
              }}
              >
                {/* Torrent status indicators */}
                {isDownloaded && (
                  <div style={{
                    position: 'absolute',
                    bottom: '8px',
                    right: '8px',
                    width: '24px',
                    height: '24px',
                    backgroundColor: '#22c55e',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    color: '#fff',
                    fontWeight: 'bold',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                    zIndex: 1
                  }}
                  title="Album downloaded and ready for instant playback"
                  >
                    ✓
                  </div>
                )}
                
                {isQueued && (
                  <div style={{
                    position: 'absolute',
                    bottom: '8px',
                    right: '8px',
                    width: '24px',
                    height: '24px',
                    backgroundColor: '#fff',
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    color: '#333',
                    fontWeight: 'bold',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                    zIndex: 1,
                    border: '1px solid #ddd'
                  }}
                  title={`Torrent found and queued (${release.torrents.length} torrent${release.torrents.length !== 1 ? 's' : ''})`}
                  >
                    ⏸
                  </div>
                )}
                
                <h3 style={{ 
                  fontSize: '16px',
                  fontWeight: 'bold',
                  margin: '0 0 8px 0',
                  color: '#fff'
                }}>
                  {release.title}
                </h3>
                <p style={{ 
                  fontSize: '14px',
                  color: '#999',
                  margin: '0'
                }}>
                  {release.date ? new Date(release.date).getFullYear() : 'Unknown Year'}
                  {release.country && ` • ${release.country}`}
                </p>
                {release.trackCount && (
                  <p style={{ 
                    fontSize: '12px',
                    color: '#777',
                    margin: '4px 0 0 0'
                  }}>
                    {release.trackCount} tracks
                  </p>
                )}
                <div style={{
                  fontSize: '10px',
                  color: '#888',
                  textTransform: 'uppercase',
                  fontWeight: 'bold',
                  marginTop: '8px',
                  padding: '2px 6px',
                  background: 'rgba(100, 108, 255, 0.2)',
                  borderRadius: '4px',
                  display: 'inline-block'
                }}>
                  {release.releaseType || 'Album'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render artist details page
  const renderArtistDetailsPage = () => {
    if (!selectedArtist) return null;

    return (
      <div style={{ 
        width: '100%', 
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)',
        color: '#fff'
      }}>
        {/* Back Arrow */}
        <div style={{ 
          position: 'absolute',
          top: 20,
          left: 20,
          zIndex: 1000,
          cursor: 'pointer',
          padding: 10,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 50,
          height: 50,
          transition: 'background 0.2s ease'
        }}
        onClick={goBackToSearch}
        onMouseEnter={(e) => e.target.style.background = 'rgba(0,0,0,0.9)'}
        onMouseLeave={(e) => e.target.style.background = 'rgba(0,0,0,0.7)'}
        >
          <span style={{ fontSize: 24, color: '#fff' }}>←</span>
        </div>

        {/* Banner Section */}
        <div style={{
          width: '100%',
          height: '300px',
          position: 'relative',
          backgroundImage: artistDetails?.bannerImage ? 
            `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.7)), url('${artistDetails.bannerImage}')` :
            'linear-gradient(135deg, #646cff 0%, #8b5cf6 100%)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          display: 'flex',
          alignItems: 'flex-end',
          padding: '40px'
        }}>
          <div>
            <h1 style={{ 
              fontSize: 'clamp(24px, 6vw, 48px)',
              fontWeight: 'bold',
              margin: 0,
              textShadow: '2px 2px 4px rgba(0,0,0,0.8)'
            }}>
              {selectedArtist.name}
            </h1>
            <p style={{ 
              fontSize: 'clamp(14px, 3vw, 18px)',
              margin: '8px 0 0 0',
              opacity: 0.9,
              textShadow: '1px 1px 2px rgba(0,0,0,0.8)'
            }}>
              {selectedArtist.type || 'Artist'} 
              {selectedArtist.country && ` • ${selectedArtist.country}`}
              {selectedArtist['life-span']?.begin && ` • ${selectedArtist['life-span'].begin}`}
            </p>
          </div>
        </div>

        {/* Content Container */}
        <div style={{ 
          padding: '40px',
          maxWidth: '1200px',
          margin: '0 auto'
        }}>
          
          {loadingArtistDetails && (
            <div style={{ 
              textAlign: 'center', 
              padding: '40px',
              fontSize: '18px' 
            }}>
              Loading artist details...
            </div>
          )}

          {artistDetails && !loadingArtistDetails && (
            <>
              {/* Bio Section */}
              {artistDetails.biography && (
                <div style={{ marginBottom: '40px' }}>
                  <h2 style={{ 
                    fontSize: 'clamp(20px, 4vw, 28px)',
                    marginBottom: '20px',
                    color: '#646cff'
                  }}>
                    Biography
                  </h2>
                  <p style={{ 
                    fontSize: '16px',
                    lineHeight: '1.6',
                    color: '#ccc',
                    maxWidth: '800px'
                  }}>
                    {artistDetails.biography}
                  </p>
                </div>
              )}

              {/* Torrent Pre-loading Status */}
              {artistDetails.torrentPreloadingInProgress && (
                <div style={{ 
                  marginBottom: '30px',
                  padding: '16px',
                  background: 'rgba(100, 108, 255, 0.1)',
                  border: '1px solid rgba(100, 108, 255, 0.3)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }}>
                  <div style={{
                    width: '20px',
                    height: '20px',
                    border: '2px solid #646cff',
                    borderTop: '2px solid transparent',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                  }}></div>
                  <span style={{ color: '#646cff', fontWeight: '500' }}>
                    Pre-loading album torrents for faster playback...
                  </span>
                </div>
              )}

              {artistDetails.torrentPreloadingCompleted && (
                <div style={{ 
                  marginBottom: '30px',
                  padding: '16px',
                  background: 'rgba(34, 197, 94, 0.1)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }}>
                  <span style={{ color: '#22c55e', fontSize: '18px' }}>✅</span>
                  <span style={{ color: '#22c55e', fontWeight: '500' }}>
                    Album torrents pre-loaded! Track playback will be faster.
                  </span>
                </div>
              )}

              {artistDetails.torrentPreloadingTimedOut && (
                <div style={{ 
                  marginBottom: '30px',
                  padding: '16px',
                  background: 'rgba(249, 115, 22, 0.1)',
                  border: '1px solid rgba(249, 115, 22, 0.3)',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }}>
                  <span style={{ color: '#f97316', fontSize: '18px' }}>⚠️</span>
                  <span style={{ color: '#f97316', fontWeight: '500' }}>
                    Torrent pre-loading is taking longer than expected. Tracks will still work but may load slower.
                  </span>
                </div>
              )}

              {/* All Releases Sections */}
              {artistDetails.releases && (
                <>
                  {renderReleaseSection(artistDetails.releases.albums, 'Albums', '💿')}
                  {renderReleaseSection(artistDetails.releases.eps, 'EPs', '🎵')}
                  {renderReleaseSection(artistDetails.releases.singles, 'Singles', '💎')}
                  {renderReleaseSection(artistDetails.releases.other, 'Other Releases', '📻')}
                </>
              )}

              {/* Fallback for legacy albums field */}
              {!artistDetails.releases && artistDetails.albums && artistDetails.albums.length > 0 && (
                renderReleaseSection(artistDetails.albums, 'Albums', '💿')
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  // Render album details page
  const renderAlbumDetailsPage = () => {
    if (!selectedAlbum) return null;

    return (
      <div style={{ 
        width: '100%', 
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%)',
        color: '#fff'
      }}>
        {/* Back Arrow */}
        <div style={{ 
          position: 'absolute',
          top: 20,
          left: 20,
          zIndex: 1000,
          cursor: 'pointer',
          padding: 10,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 50,
          height: 50,
          transition: 'background 0.2s ease'
        }}
        onClick={goBackToArtist}
        onMouseEnter={(e) => e.target.style.background = 'rgba(0,0,0,0.9)'}
        onMouseLeave={(e) => e.target.style.background = 'rgba(0,0,0,0.7)'}
        >
          <span style={{ fontSize: 24, color: '#fff' }}>←</span>
        </div>

        {/* Album Header */}
        <div style={{
          width: '100%',
          height: '200px',
          position: 'relative',
          backgroundImage: albumDetails?.coverArt ? 
            `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.7)), url('${albumDetails.coverArt}')` :
            'linear-gradient(135deg, #646cff 0%, #8b5cf6 100%)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          display: 'flex',
          alignItems: 'flex-end',
          padding: '40px'
        }}>
          <div>
            <h1 style={{ 
              fontSize: 'clamp(20px, 5vw, 36px)',
              fontWeight: 'bold',
              margin: 0,
              textShadow: '2px 2px 4px rgba(0,0,0,0.8)'
            }}>
              {selectedAlbum.title}
            </h1>
            <p style={{ 
              fontSize: 'clamp(14px, 3vw, 18px)',
              margin: '8px 0 0 0',
              opacity: 0.9,
              textShadow: '1px 1px 2px rgba(0,0,0,0.8)'
            }}>
              by {selectedArtist?.name || 'Unknown Artist'}
              {selectedAlbum.date && ` • ${new Date(selectedAlbum.date).getFullYear()}`}
              {selectedAlbum.trackCount && ` • ${selectedAlbum.trackCount} tracks`}
            </p>
          </div>
        </div>

        {/* Content Container */}
        <div style={{ 
          padding: '40px',
          maxWidth: '1000px',
          margin: '0 auto'
        }}>
          
          {loadingAlbumDetails && (
            <div style={{ 
              textAlign: 'center', 
              padding: '40px',
              fontSize: '18px' 
            }}>
              Loading album details...
            </div>
          )}

          {albumDetails && !loadingAlbumDetails && (
            <>
              {/* Album Info */}
              {(albumDetails.barcode || albumDetails.status) && (
                <div style={{ marginBottom: '30px' }}>
                  <h2 style={{ 
                    fontSize: 'clamp(18px, 4vw, 24px)',
                    marginBottom: '15px',
                    color: '#646cff'
                  }}>
                    Album Information
                  </h2>
                  <div style={{ color: '#ccc', fontSize: '14px' }}>
                    {albumDetails.status && <p>Status: {albumDetails.status}</p>}
                    {albumDetails.barcode && <p>Barcode: {albumDetails.barcode}</p>}
                  </div>
                </div>
              )}

              {/* Track List */}
              {albumDetails.tracks && albumDetails.tracks.length > 0 && (
                <div>
                  <h2 style={{ 
                    fontSize: 'clamp(18px, 4vw, 24px)',
                    marginBottom: '20px',
                    color: '#646cff'
                  }}>
                    Track List ({albumDetails.tracks.length} tracks)
                  </h2>
                  
                  <div style={{ 
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '12px',
                    padding: '20px'
                  }}>
                    {albumDetails.tracks.map((track, index) => {
                      const trackId = track.id || `${selectedAlbum.id}-${index}`;
                      const isLoadingTorrents = loadingTorrents[trackId];
                      const trackTorrents = torrents[trackId] || [];
                      const hasSearchedTorrents = trackId in torrents;
                      
                      return (
                        <div key={track.id || index}>
                          {/* Track Row */}
                          <div 
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              padding: '12px 16px',
                              borderRadius: '8px',
                              margin: '4px 0',
                              transition: 'background 0.2s ease',
                              background: 'transparent'
                            }}
                          >
                            <div style={{ 
                              minWidth: '40px',
                              fontSize: '14px',
                              color: '#999',
                              textAlign: 'center'
                            }}>
                              {track.position || index + 1}
                            </div>
                            
                            <div style={{ flex: 1, marginLeft: '16px' }}>
                              <div style={{ 
                                fontSize: '16px',
                                fontWeight: '500',
                                color: '#fff'
                              }}>
                                {track.title}
                              </div>
                              {track.length && (
                                <div style={{ 
                                  fontSize: '12px',
                                  color: '#777',
                                  marginTop: '2px'
                                }}>
                                  {track.length}
                                </div>
                              )}
                            </div>
                            
                            {track.artist && track.artist !== selectedArtist?.name && (
                              <div style={{ 
                                fontSize: '14px',
                                color: '#999',
                                marginLeft: '16px'
                              }}>
                                {track.artist}
                              </div>
                            )}
                            
                            {/* Find Torrents Button */}
                            <button
                              onClick={async () => {
                                const trackSearchItem = {
                                  id: trackId,
                                  title: track.title,
                                  artist: selectedArtist?.name,
                                  albumArtist: selectedArtist?.name,
                                  album: selectedAlbum?.title,
                                  'artist-credit': [{ name: selectedArtist?.name }]
                                };
                                await searchTorrents(trackSearchItem, 'recording');
                              }}
                              disabled={isLoadingTorrents}
                              style={{
                                background: isLoadingTorrents ? '#555' : '#444',
                                color: '#fff',
                                border: 'none',
                                padding: '6px 12px',
                                borderRadius: '16px',
                                cursor: isLoadingTorrents ? 'not-allowed' : 'pointer',
                                opacity: isLoadingTorrents ? 0.6 : 1,
                                fontSize: '11px',
                                marginLeft: '16px',
                                transition: 'background 0.2s ease'
                              }}
                              onMouseEnter={(e) => {
                                if (!isLoadingTorrents) e.target.style.background = '#555';
                              }}
                              onMouseLeave={(e) => {
                                if (!isLoadingTorrents) e.target.style.background = '#444';
                              }}
                            >
                              {isLoadingTorrents ? '⏳' : '🏴‍☠️'}
                            </button>
                          </div>
                          
                          {/* Torrent Results for this Track */}
                          {hasSearchedTorrents && (
                            <div style={{ 
                              marginLeft: '56px', 
                              marginBottom: '16px',
                              padding: '0 16px'
                            }}>
                              {trackTorrents === 'searching' ? (
                                <div style={{ 
                                  color: '#646cff', 
                                  fontStyle: 'italic',
                                  fontSize: '12px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px'
                                }}>
                                  <div style={{
                                    width: '12px',
                                    height: '12px',
                                    border: '2px solid #646cff',
                                    borderTop: '2px solid transparent',
                                    borderRadius: '50%',
                                    animation: 'spin 1s linear infinite'
                                  }}></div>
                                  🔍 Searching for best torrents asynchronously...
                                </div>
                              ) : trackTorrents.length > 0 ? (
                                <>
                                  <div style={{ 
                                    color: '#646cff', 
                                    fontWeight: 'bold', 
                                    marginBottom: '8px',
                                    fontSize: '12px'
                                  }}>
                                    🏴‍☠️ Found {trackTorrents.length} Torrents:
                                  </div>
                                  <div style={{ 
                                    display: 'grid', 
                                    gap: 8,
                                    maxHeight: '240px', // Allow for about 3-4 torrents visible
                                    overflowY: 'auto',
                                    paddingRight: '4px',
                                    // Custom scrollbar styling
                                    scrollbarWidth: 'thin',
                                    scrollbarColor: '#646cff #333',
                                    // Webkit scrollbar styling
                                    WebkitScrollbar: {
                                      width: '6px'
                                    },
                                    border: '1px solid #333',
                                    borderRadius: '4px',
                                    padding: '4px'
                                  }}
                                  // Add scrollbar CSS for webkit browsers
                                  className="torrent-list-scroll"
                                  >
                                    {trackTorrents.slice(0, 20).map((torrent, idx) => (
                                      <div key={idx} style={{ 
                                        background: '#222', 
                                        padding: '8px 12px', 
                                        borderRadius: 6,
                                        border: '1px solid #444',
                                        fontSize: '11px'
                                      }}>
                                        <div style={{ 
                                          fontWeight: 'bold', 
                                          color: '#fff', 
                                          marginBottom: 4,
                                          fontSize: '12px'
                                        }}>
                                          {torrent.title}
                                        </div>
                                        <div style={{ 
                                          display: 'flex', 
                                          justifyContent: 'space-between',
                                          alignItems: 'center',
                                          color: '#999',
                                          marginBottom: 6
                                        }}>
                                          <span>{torrent.size}</span>
                                          <span>S:{torrent.seeders} L:{torrent.leechers}</span>
                                        </div>
                                        <div style={{ 
                                          display: 'flex', 
                                          gap: 6, 
                                          alignItems: 'center'
                                        }}>
                                          <button
                                            onClick={() => {
                                              const trackSearchItem = {
                                                id: trackId,
                                                title: track.title,
                                                artist: selectedArtist?.name,
                                                albumArtist: selectedArtist?.name,
                                                album: selectedAlbum?.title
                                              };
                                              // Use album track count for expected file count
                                              const expectedFileCount = albumDetails?.tracks?.length || selectedAlbum?.trackCount || 1;
                                              playTorrentAudio(torrent, trackSearchItem, expectedFileCount);
                                            }}
                                            style={{
                                              background: '#1db954',
                                              color: '#fff',
                                              border: 'none',
                                              padding: '4px 8px',
                                              borderRadius: 3,
                                              cursor: 'pointer',
                                              fontSize: '10px',
                                              fontWeight: 'bold'
                                            }}
                                          >
                                            ▶️ Stream
                                          </button>
                                          {torrent.url && torrent.url !== '#' && (
                                            <a 
                                              href={torrent.url} 
                                              target="_blank" 
                                              rel="noopener noreferrer"
                                              style={{ 
                                                color: '#646cff', 
                                                textDecoration: 'none',
                                                padding: '4px 8px',
                                                background: '#333',
                                                borderRadius: 3,
                                                fontSize: '10px'
                                              }}
                                            >
                                              Download
                                            </a>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                  {trackTorrents.length > 3 && (
                                    <div style={{ 
                                      fontSize: '10px', 
                                      color: '#888', 
                                      textAlign: 'center',
                                      marginTop: '4px',
                                      fontStyle: 'italic'
                                    }}>
                                      ↕️ Scroll to see all {Math.min(trackTorrents.length, 20)} torrents
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div style={{ 
                                  color: '#888', 
                                  fontStyle: 'italic',
                                  fontSize: '12px'
                                }}>
                                  No torrents found for this track
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Custom CSS for torrent list scrollbar */}
      <style dangerouslySetInnerHTML={{
        __html: `
          .torrent-list-scroll::-webkit-scrollbar {
            width: 6px;
          }
          .torrent-list-scroll::-webkit-scrollbar-track {
            background: #333;
            border-radius: 3px;
          }
          .torrent-list-scroll::-webkit-scrollbar-thumb {
            background: #646cff;
            border-radius: 3px;
          }
          .torrent-list-scroll::-webkit-scrollbar-thumb:hover {
            background: #5a5fcf;
          }
        `
      }} />
      
      <div className="app-container">
        {currentView === 'album' ? renderAlbumDetailsPage() : 
         currentView === 'artist' ? renderArtistDetailsPage() : (
          <>
            <h1 style={{ 
              fontSize: 'clamp(24px, 5vw, 32px)',
              margin: '20px 0',
              color: '#fff'
            }}>Lizzen Music</h1>
            <form onSubmit={handleSearch} className="search-form" style={{ 
        marginBottom: 24,
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        justifyContent: 'center',
        flexWrap: 'nowrap'
      }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search for songs, artists, or albums..."
          className="search-input"
          style={{ 
            padding: '0 16px',
            flex: '1 1 auto',
            maxWidth: 400,
            minWidth: 150,
            fontSize: 16, 
            borderRadius: 6, 
            border: '1px solid #555',
            backgroundColor: '#2a2a2a',
            color: '#fff'
          }}
        />
        <button 
          type="submit" 
          className="search-button"
          style={{ 
            padding: '12px',
            fontSize: 18,
            borderRadius: 6,
            border: '1px solid #646cff',
            background: '#646cff',
            color: 'white',
            cursor: 'pointer',
            width: '48px',
            height: '48px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'background-color 0.2s ease'
          }} 
          disabled={loading}
          onMouseEnter={(e) => e.target.style.backgroundColor = '#5a5fcf'}
          onMouseLeave={(e) => e.target.style.backgroundColor = '#646cff'}
        >
          {loading ? '⟳' : '🔍'}
        </button>
      </form>
      
      {error && <div style={{ 
        color: 'red', 
        marginBottom: 16,
        textAlign: 'center',
        padding: '10px',
        backgroundColor: 'rgba(255, 0, 0, 0.1)',
        borderRadius: '6px',
        maxWidth: '600px',
        width: '100%'
      }}>{error}</div>}
      
      {categories && (
        <div style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '20px'
        }}>
          {/* Artists Grid at the top */}
          {renderCategory(categories.artists, 'artist')}
          
          {/* Songs and Albums below */}
          {renderCategory(categories.songs, 'recording')}
          {renderCategory(categories.albums, 'release')}
        </div>
      )}
        </>
      )}
      </div>
      
      {/* CSS for spinner animation */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}

export default App;
