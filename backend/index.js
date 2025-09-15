import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import WebTorrent from 'webtorrent';

const app = express();
app.use(express.json());
app.use(cors()); // Enable CORS for frontend requests

// Global cache for artist image search attempts
const artistImageSearchCache = new Map();
const globalImageSearchCounter = { count: 0, resetTime: Date.now() };
const MAX_GLOBAL_IMAGE_SEARCH_ATTEMPTS = 10; // Maximum total attempts across all artists
const MAX_ATTEMPTS_PER_ARTIST = 1; // Maximum attempts per individual artist
const RESET_INTERVAL = 5 * 60 * 1000; // Reset counter every 5 minutes

// WebTorrent client for server-side torrent streaming
const torrentClient = new WebTorrent();
const activeTorrents = new Map(); // Track active torrents by magnet link

// WebTorrent client event handlers
torrentClient.on('error', (err) => {
  console.error('❌ WebTorrent client error:', err);
});

torrentClient.on('warning', (err) => {
  console.warn('⚠️ WebTorrent client warning:', err);
});

console.log('✅ WebTorrent client initialized');

// Clean up the cache every 30 minutes and reset global counter
setInterval(() => {
  console.log(`🧹 Cleaning up artist image search cache. Current size: ${artistImageSearchCache.size}`);
  console.log(`🔢 Global attempts before reset: ${globalImageSearchCounter.count}`);
  artistImageSearchCache.clear(); // Clear all entries periodically
  globalImageSearchCounter.count = 0; // Reset global counter
  globalImageSearchCounter.resetTime = Date.now();
  console.log(`✅ Cache and global counter cleaned up`);
}, 30 * 60 * 1000); // 30 minutes

// Configuration
const PROWLARR_CONFIG = {
  apiKey: '137b42b4e22c44309e12faed42b9b4c0',
  baseUrl: 'http://localhost:9696/api/v1', // Prowlarr default port
  musicCategories: [3000, 3010, 3020, 3030, 3040] // Music categories as array of numbers
};

const MUSICBRAINZ_CONFIG = {
  baseUrl: 'https://musicbrainz.org/ws/2',
  userAgent: 'LizzenWebApp/1.0.0 (contact@lizzen.org)', // Updated with your domain
  rateLimit: 1000, // 1 request per second as per their guidelines
  domain: 'https://lizzen.org',
  callbackUri: 'https://lizzen.org/api/musicbrainz/callback'
};

// Rate limiting for MusicBrainz API calls
let lastMusicBrainzCall = 0;
async function rateLimitedMusicBrainzCall(url, config) {
  const now = Date.now();
  const timeSinceLastCall = now - lastMusicBrainzCall;
  const minInterval = MUSICBRAINZ_CONFIG.rateLimit; // 1 second
  
  if (timeSinceLastCall < minInterval) {
    const waitTime = minInterval - timeSinceLastCall;
    console.log(`⏰ Rate limiting: waiting ${waitTime}ms before MusicBrainz call`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastMusicBrainzCall = Date.now();
  return axios.get(url, config);
}

// Helper function to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper function to add timeout to any promise
function withTimeout(promise, timeoutMs = 40000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// Helper function to retry API calls with exponential backoff
async function retryApiCall(apiCall, maxAttempts = 10, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`🔄 API call attempt ${attempt}/${maxAttempts}`);
      const result = await apiCall();
      console.log(`✅ API call succeeded on attempt ${attempt}`);
      return result;
    } catch (error) {
      console.log(`❌ API call failed on attempt ${attempt}: ${error.message}`);
      
      if (attempt === maxAttempts) {
        console.log(`🚫 Max attempts (${maxAttempts}) reached, giving up`);
        throw error;
      }
      
      // Calculate delay with exponential backoff (but cap at 10 seconds)
      const delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), 10000);
      console.log(`⏱️ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Function to search MusicBrainz for metadata
async function searchMusicBrainz(query) {
  console.log(`🎵 Searching MusicBrainz for: "${query}"`);
  
  try {
    // Search for artists, releases, and recordings with rate limiting
    console.log(`⏰ Making 3 rate-limited calls to MusicBrainz...`);
    
    const artistResponse = await rateLimitedMusicBrainzCall(`${MUSICBRAINZ_CONFIG.baseUrl}/artist`, {
      headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
      params: { query: query, fmt: 'json', limit: 5 }
    });
    
    const releaseResponse = await rateLimitedMusicBrainzCall(`${MUSICBRAINZ_CONFIG.baseUrl}/release`, {
      headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
      params: { query: query, fmt: 'json', limit: 5 }
    });
    
    const recordingResponse = await rateLimitedMusicBrainzCall(`${MUSICBRAINZ_CONFIG.baseUrl}/recording`, {
      headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
      params: { query: query, fmt: 'json', limit: 5 }
    });

    const results = {
      artists: artistResponse.data.artists || [],
      releases: releaseResponse.data.releases || [],
      recordings: recordingResponse.data.recordings || []
    };

    console.log(`✅ MusicBrainz results: ${results.artists.length} artists, ${results.releases.length} releases, ${results.recordings.length} recordings`);
    
    return results;
  } catch (error) {
    console.error(`❌ MusicBrainz search error: ${error.message}`);
    return { artists: [], releases: [], recordings: [], error: error.message };
  }
}

// Function to generate enhanced search queries from MusicBrainz data
function generateEnhancedQueries(musicbrainzResults, originalQuery) {
  const queries = [originalQuery]; // Always include original query
  
  // Add artist + release combinations
  musicbrainzResults.artists.forEach(artist => {
    musicbrainzResults.releases.forEach(release => {
      if (release['artist-credit'] && release['artist-credit'][0]?.name === artist.name) {
        queries.push(`${artist.name} ${release.title}`);
      }
    });
  });
  
  // Add recording + artist combinations
  musicbrainzResults.recordings.forEach(recording => {
    if (recording['artist-credit'] && recording['artist-credit'][0]) {
      queries.push(`${recording['artist-credit'][0].name} ${recording.title}`);
    }
  });
  
  // Remove duplicates and limit to top 3 queries
  return [...new Set(queries)].slice(0, 3);
}

// Enhanced search function that uses MusicBrainz + Prowlarr
async function enhancedMusicSearch(query) {
  console.log(`🔍 Starting enhanced search for: "${query}"`);
  
  // Step 1: Search MusicBrainz for metadata
  const musicbrainzResults = await searchMusicBrainz(query);
  
  // Step 2: Generate enhanced search queries
  const enhancedQueries = generateEnhancedQueries(musicbrainzResults, query);
  console.log(`🎯 Generated ${enhancedQueries.length} enhanced queries:`, enhancedQueries);
  
  // Step 3: Search Prowlarr with each enhanced query
  const allResults = [];
  for (const enhancedQuery of enhancedQueries) {
    console.log(`🔍 Searching Prowlarr with: "${enhancedQuery}"`);
    const results = await searchProwlarr(enhancedQuery);
    if (results && !results.error && Array.isArray(results)) {
      allResults.push(...results);
    }
    // Rate limit between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Step 4: Remove duplicates
  const uniqueResults = removeDuplicateResults(allResults);
  
  // Step 5: Categorize results using MusicBrainz data
  const categorizedResults = categorizeSearchResults(uniqueResults, musicbrainzResults, query);
  
  console.log(`✅ Enhanced search complete: ${uniqueResults.length} unique results categorized`);
  console.log(`📊 Categories: Songs(${categorizedResults.songs.results.length}), Artists(${categorizedResults.artists.results.length}), Albums(${categorizedResults.albums.results.length}), Other(${categorizedResults.other.results.length})`);
  
  return {
    categories: categorizedResults,
    totalResults: uniqueResults.length,
    musicbrainzData: musicbrainzResults,
    queriesUsed: enhancedQueries
  };
}

// Function to remove duplicate results
function removeDuplicateResults(results) {
  const seen = new Set();
  return results.filter(result => {
    const key = `${result.title}-${result.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Function to enrich Prowlarr results with MusicBrainz metadata
function enrichResultsWithMusicBrainz(prowlarrResults, musicbrainzData) {
  return prowlarrResults.map(result => {
    // Try to match with MusicBrainz data
    const matchingArtist = musicbrainzData.artists.find(artist => 
      result.title.toLowerCase().includes(artist.name.toLowerCase())
    );
    
    const matchingRelease = musicbrainzData.releases.find(release => 
      result.title.toLowerCase().includes(release.title.toLowerCase())
    );
    
    return {
      ...result,
      musicbrainz: {
        artist: matchingArtist ? {
          name: matchingArtist.name,
          id: matchingArtist.id,
          country: matchingArtist.country,
          type: matchingArtist.type
        } : null,
        release: matchingRelease ? {
          title: matchingRelease.title,
          id: matchingRelease.id,
          date: matchingRelease.date,
          status: matchingRelease.status
        } : null
      }
    };
  });
}
async function searchProwlarr(query) {
  console.log(`📡 Searching Prowlarr for: "${query}"`);
  console.log(`🔗 URL: ${PROWLARR_CONFIG.baseUrl}/search`);
  
  try {
    // First try without categories to see if it works
    const response = await axios.get(`${PROWLARR_CONFIG.baseUrl}/search`, {
      headers: { 'X-Api-Key': PROWLARR_CONFIG.apiKey },
      params: {
        query: query,
        type: 'search'
        // categories: PROWLARR_CONFIG.musicCategories, // Temporarily disabled
      }
    });
    
    console.log(`✅ Prowlarr response status: ${response.status}`);
    console.log(`📊 Results count: ${response.data?.length || 0}`);
    
    // Debug: Log the structure of the first few results to understand available fields
    if (response.data && response.data.length > 0) {
      console.log(`🔍 DEBUG: First result structure:`);
      const firstResult = response.data[0];
      console.log(`   Available fields:`, Object.keys(firstResult));
      console.log(`   downloadUrl:`, firstResult.downloadUrl);
      console.log(`   magnetUrl:`, firstResult.magnetUrl);
      console.log(`   infoUrl:`, firstResult.infoUrl);
      console.log(`   guid:`, firstResult.guid);
      console.log(`   link:`, firstResult.link);
      
      // Check if there are any other fields that might contain the actual magnet
      const allFields = Object.keys(firstResult);
      const magnetFields = allFields.filter(field => 
        field.toLowerCase().includes('magnet') || 
        field.toLowerCase().includes('torrent') ||
        field.toLowerCase().includes('hash')
      );
      console.log(`   Potential magnet fields:`, magnetFields);
      
      if (magnetFields.length > 0) {
        magnetFields.forEach(field => {
          console.log(`   ${field}:`, firstResult[field]);
        });
      }
    }
    
    return response.data;
  } catch (error) {
    console.error('❌ Prowlarr search error:');
    console.error(`   Status: ${error.response?.status || 'N/A'}`);
    console.error(`   Message: ${error.message}`);
    console.error(`   URL: ${error.config?.url || 'N/A'}`);
    if (error.response?.data) {
      console.error(`   Response data:`, JSON.stringify(error.response.data, null, 2));
    }
    return { error: error.message };
  }
}

// Function to clean and format results for frontend with categories
function cleanSearchResults(prowlarrResults) {
  if (!Array.isArray(prowlarrResults)) {
    return [];
  }
  
  return prowlarrResults.map(result => {
    // Debug log both URLs
    console.log(`🔍 Torrent: ${result.title}`);
    console.log(`  📎 magnetUrl: ${result.magnetUrl || 'NOT PROVIDED'}`);
    console.log(`  🔗 downloadUrl: ${result.downloadUrl || 'NOT PROVIDED'}`);
    
    return {
      title: result.title || 'Unknown Title',
      url: result.magnetUrl || result.downloadUrl || '#',
      magnetUrl: result.magnetUrl || null,
      downloadUrl: result.downloadUrl || null,
      size: result.size ? formatBytes(result.size) : 'Unknown',
      seeders: result.seeders || 0,
      leechers: result.leechers || 0,
      indexer: result.indexer || 'Unknown',
      category: result.categoryDesc || 'Music',
      publishDate: result.publishDate ? new Date(result.publishDate).toLocaleDateString() : 'Unknown'
    };
  });
}

// Function to categorize search results based on MusicBrainz data
function categorizeSearchResults(prowlarrResults, musicbrainzData, originalQuery) {
  const cleanedResults = cleanSearchResults(prowlarrResults);
  
  const categories = {
    songs: {
      title: 'Songs/Tracks',
      results: [],
      musicbrainzMatches: []
    },
    artists: {
      title: 'Artists',
      results: [],
      musicbrainzMatches: []
    },
    albums: {
      title: 'Albums/Releases',
      results: [],
      musicbrainzMatches: []
    },
    other: {
      title: 'Other Results',
      results: [],
      musicbrainzMatches: []
    }
  };

  // Add MusicBrainz data to categories
  categories.songs.musicbrainzMatches = musicbrainzData.recordings || [];
  categories.artists.musicbrainzMatches = musicbrainzData.artists || [];
  categories.albums.musicbrainzMatches = musicbrainzData.releases || [];

  // Categorize Prowlarr results
  cleanedResults.forEach(result => {
    const titleLower = result.title.toLowerCase();
    let categorized = false;

    // Check if it matches any MusicBrainz recordings (songs)
    const matchingSong = musicbrainzData.recordings?.find(recording => 
      titleLower.includes(recording.title.toLowerCase()) ||
      (recording['artist-credit'] && 
       recording['artist-credit'].some(artist => 
         titleLower.includes(artist.name.toLowerCase())
       ))
    );

    if (matchingSong) {
      categories.songs.results.push({
        ...result,
        musicbrainzMatch: {
          type: 'recording',
          id: matchingSong.id,
          title: matchingSong.title,
          artist: matchingSong['artist-credit']?.[0]?.name || 'Unknown Artist',
          length: matchingSong.length ? Math.round(matchingSong.length / 1000) + 's' : null,
          score: matchingSong.score || 0
        }
      });
      categorized = true;
    }

    // Check if it matches any MusicBrainz artists
    if (!categorized) {
      const matchingArtist = musicbrainzData.artists?.find(artist => 
        titleLower.includes(artist.name.toLowerCase()) ||
        artist.aliases?.some(alias => titleLower.includes(alias.name.toLowerCase()))
      );

      if (matchingArtist) {
        categories.artists.results.push({
          ...result,
          musicbrainzMatch: {
            type: 'artist',
            id: matchingArtist.id,
            name: matchingArtist.name,
            country: matchingArtist.country || 'Unknown',
            type: matchingArtist.type || 'Unknown',
            score: matchingArtist.score || 0
          }
        });
        categorized = true;
      }
    }

    // Check if it matches any MusicBrainz releases (albums)
    if (!categorized) {
      const matchingRelease = musicbrainzData.releases?.find(release => 
        titleLower.includes(release.title.toLowerCase()) ||
        (release['artist-credit'] && 
         release['artist-credit'].some(artist => 
           titleLower.includes(artist.name.toLowerCase())
         ))
      );

      if (matchingRelease) {
        categories.albums.results.push({
          ...result,
          musicbrainzMatch: {
            type: 'release',
            id: matchingRelease.id,
            title: matchingRelease.title,
            artist: matchingRelease['artist-credit']?.[0]?.name || 'Unknown Artist',
            date: matchingRelease.date || 'Unknown',
            status: matchingRelease.status || 'Unknown',
            score: matchingRelease.score || 0
          }
        });
        categorized = true;
      }
    }

    // If no category match, put in "other"
    if (!categorized) {
      categories.other.results.push(result);
    }
  });

  // Sort results within each category by seeders (descending)
  Object.values(categories).forEach(category => {
    category.results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  });

  return categories;
}

// Function to get indexers from Prowlarr
async function getProwlarrIndexers() {
  console.log(`🔍 Fetching Prowlarr indexers from: ${PROWLARR_CONFIG.baseUrl}/indexer`);
  
  try {
    const response = await axios.get(`${PROWLARR_CONFIG.baseUrl}/indexer`, {
      headers: { 'X-Api-Key': PROWLARR_CONFIG.apiKey }
    });
    
    console.log(`✅ Indexers response status: ${response.status}`);
    console.log(`📋 Indexers count: ${response.data?.length || 0}`);
    
    return response.data;
  } catch (error) {
    console.error('❌ Prowlarr indexers error:');
    console.error(`   Status: ${error.response?.status || 'N/A'}`);
    console.error(`   Message: ${error.message}`);
    console.error(`   URL: ${error.config?.url || 'N/A'}`);
    if (error.response?.data) {
      console.error(`   Response data:`, error.response.data);
    }
    return { error: error.message };
  }
}

// Helper function for web scraping
async function scrapeAndSearch(url, searchTerms) {
  console.log(`🌐 Scraping URL: ${url}`);
  console.log(`🔍 Search terms: [${searchTerms.join(', ')}]`);
  
  try {
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);
    const text = $('body').text();
    const foundTerms = searchTerms.filter(term =>
      text.toLowerCase().includes(term.toLowerCase())
    );
    
    console.log(`✅ Scraping successful for ${url}`);
    console.log(`📊 Found terms: [${foundTerms.join(', ')}]`);
    
    return { url, foundTerms };
  } catch (err) {
    console.error(`❌ Scraping failed for ${url}:`);
    console.error(`   Error: ${err.message}`);
    console.error(`   Status: ${err.response?.status || 'N/A'}`);
    return { url, error: err.message };
  }
}

// ROUTES

// Health check endpoint for WebTorrent service
app.get('/api/health', (req, res) => {
  const torrentStats = {
    isReady: !!torrentClient,
    activeTorrents: activeTorrents.size,
    clientStats: {
      torrents: torrentClient.torrents.length,
      downloadSpeed: torrentClient.downloadSpeed,
      uploadSpeed: torrentClient.uploadSpeed,
      peerId: torrentClient.peerId ? torrentClient.peerId.toString('hex').substring(0, 20) : null
    }
  };

  console.log(`🩺 Health check requested - WebTorrent status:`, torrentStats);

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      webTorrent: torrentStats,
      prowlarr: {
        configured: !!process.env.PROWLARR_API_KEY || 'localhost:9696',
        endpoint: 'http://localhost:9696'
      }
    }
  });
});

// WebTorrent test endpoint
app.post('/api/test-magnet', async (req, res) => {
  const { magnetLink } = req.body;
  
  if (!magnetLink) {
    return res.status(400).json({ error: 'Magnet link is required' });
  }

  console.log(`🧪 Testing magnet link: ${magnetLink.substring(0, 50)}...`);

  try {
    // Test if magnet link is valid format
    if (!magnetLink.startsWith('magnet:')) {
      return res.status(400).json({ 
        error: 'Invalid magnet link format',
        provided: magnetLink.substring(0, 100)
      });
    }

    // Try to parse the torrent without adding it
    const testResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve({ 
          success: false, 
          error: 'Magnet link test timed out (5s) - may have no active peers',
          canConnect: false
        });
      }, 5000); // Reduced to 5 seconds

      try {
        // First do basic magnet link validation
        if (!magnetLink.includes('xt=urn:btih:')) {
          clearTimeout(timeout);
          resolve({
            success: false,
            error: 'Invalid magnet link format - missing info hash',
            canConnect: false
          });
          return;
        }

        // Create a temporary torrent instance for testing
        const testTorrent = torrentClient.add(magnetLink, { 
          destroyStoreOnDestroy: true,
          downloadLimit: 0, // Don't actually download anything
          uploadLimit: 0    // Don't upload anything
        });

        // Success on metadata (full info available)
        testTorrent.on('metadata', () => {
          clearTimeout(timeout);
          const result = {
            success: true,
            name: testTorrent.name,
            files: testTorrent.files.length,
            size: testTorrent.length,
            infoHash: testTorrent.infoHash,
            canConnect: true,
            source: 'metadata'
          };
          
          // Clean up test torrent
          testTorrent.destroy();
          resolve(result);
        });

        // Basic success if we can at least parse the magnet link
        setTimeout(() => {
          if (testTorrent.infoHash) {
            clearTimeout(timeout);
            const result = {
              success: true,
              name: testTorrent.name || 'Unknown',
              files: testTorrent.files?.length || 0,
              size: testTorrent.length || 0,
              infoHash: testTorrent.infoHash,
              canConnect: testTorrent.peers?.length > 0,
              source: 'basic_parse'
            };
            
            // Clean up test torrent
            testTorrent.destroy();
            resolve(result);
          }
        }, 2000); // Give it 2 seconds to at least parse

        testTorrent.on('error', (err) => {
          clearTimeout(timeout);
          testTorrent.destroy();
          resolve({ 
            success: false, 
            error: err.message,
            canConnect: false
          });
        });

      } catch (err) {
        clearTimeout(timeout);
        resolve({ 
          success: false, 
          error: err.message,
          canConnect: false
        });
      }
    });

    res.json(testResult);

  } catch (error) {
    console.error('❌ Error testing magnet link:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Resolve magnet URL endpoint
app.post('/api/resolve-magnet', async (req, res) => {
  const { downloadUrl } = req.body;
  
  if (!downloadUrl) {
    return res.status(400).json({ error: 'Download URL is required' });
  }

  console.log(`🔗 Resolving download URL: ${downloadUrl.substring(0, 60)}...`);

  try {
    const resolvedMagnetLink = await resolveMagnetUrl(downloadUrl);
    
    if (resolvedMagnetLink && resolvedMagnetLink !== downloadUrl) {
      console.log(`✅ Successfully resolved to magnet URL: ${resolvedMagnetLink.substring(0, 60)}...`);
      res.json({
        success: true,
        magnetUrl: resolvedMagnetLink,
        originalUrl: downloadUrl
      });
    } else {
      console.log(`⚠️ Could not resolve download URL to magnet link`);
      res.json({
        success: false,
        error: 'Could not resolve download URL to magnet link',
        originalUrl: downloadUrl
      });
    }

  } catch (error) {
    console.error('❌ Error resolving magnet URL:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Main search endpoint for frontend (MusicBrainz only)
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  
  console.log(`\n🔍 === NEW MUSICBRAINZ SEARCH ===`);
  console.log(`📝 Query: "${q}"`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  console.log(`🌐 Client IP: ${req.ip || req.connection.remoteAddress}`);
  
  if (!q) {
    console.log(`❌ Missing query parameter`);
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }
  
  try {
    // Only search MusicBrainz, not Prowlarr
    const musicbrainzResults = await searchMusicBrainz(q);
    
    if (musicbrainzResults.error) {
      console.log(`❌ MusicBrainz returned error: ${musicbrainzResults.error}`);
      return res.status(500).json({ error: musicbrainzResults.error });
    }
    
    console.log(`✅ MusicBrainz search completed successfully`);
    console.log(`📊 Found: ${musicbrainzResults.artists?.length || 0} artists, ${musicbrainzResults.releases?.length || 0} albums, ${musicbrainzResults.recordings?.length || 0} songs`);
    console.log(`=== END MUSICBRAINZ SEARCH ===\n`);
    
    res.json({
      query: q,
      totalResults: (musicbrainzResults.artists?.length || 0) + 
                   (musicbrainzResults.releases?.length || 0) + 
                   (musicbrainzResults.recordings?.length || 0),
      categories: {
        songs: {
          title: 'Songs/Tracks',
          results: musicbrainzResults.recordings || [],
          count: musicbrainzResults.recordings?.length || 0
        },
        artists: {
          title: 'Artists',
          results: musicbrainzResults.artists || [],
          count: musicbrainzResults.artists?.length || 0
        },
        albums: {
          title: 'Albums/Releases',
          results: musicbrainzResults.releases || [],
          count: musicbrainzResults.releases?.length || 0
        }
      }
    });
    
  } catch (error) {
    console.error(`❌ Unexpected search error:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.log(`=== END MUSICBRAINZ SEARCH (ERROR) ===\n`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// New endpoint to search Prowlarr for a specific MusicBrainz item
app.post('/api/search-torrents', async (req, res) => {
  const { musicbrainzItem, type } = req.body;
  
  console.log(`\n🏴‍☠️ === PROWLARR TORRENT SEARCH ===`);
  console.log(`📝 Type: ${type}`);
  console.log(`🎵 MusicBrainz ID: ${musicbrainzItem.id}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!musicbrainzItem || !type) {
    console.log(`❌ Missing musicbrainzItem or type`);
    return res.status(400).json({ error: 'musicbrainzItem and type are required' });
  }
  
  try {
    // Generate search queries based on MusicBrainz item
    let searchQueries = [];
    
    if (type === 'recording') {
      // For songs: "Artist - Song Title"
      const artist = musicbrainzItem['artist-credit']?.[0]?.name || '';
      searchQueries = [
        `${artist} ${musicbrainzItem.title}`,
        musicbrainzItem.title,
        artist
      ].filter(q => q.trim());
    } else if (type === 'artist') {
      // For artists: "Artist Name"
      searchQueries = [
        musicbrainzItem.name,
        ...((musicbrainzItem.aliases || []).map(alias => alias.name))
      ].filter(q => q.trim());
    } else if (type === 'release') {
      // For albums: "Artist - Album"
      const artist = musicbrainzItem['artist-credit']?.[0]?.name || '';
      searchQueries = [
        `${artist} ${musicbrainzItem.title}`,
        musicbrainzItem.title,
        artist
      ].filter(q => q.trim());
    }
    
    console.log(`🎯 Generated search queries:`, searchQueries.slice(0, 3));
    
    // Search Prowlarr with generated queries
    const allResults = [];
    for (const query of searchQueries.slice(0, 3)) { // Limit to 3 queries
      console.log(`🔍 Searching Prowlarr with: "${query}"`);
      const results = await searchProwlarr(query);
      if (results && !results.error && Array.isArray(results)) {
        allResults.push(...results);
      }
      // Rate limit between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Remove duplicates and clean results
    const uniqueResults = removeDuplicateResults(allResults);
    const cleanedResults = cleanSearchResults(uniqueResults);
    
    console.log(`✅ Prowlarr search completed successfully`);
    console.log(`📊 Found ${cleanedResults.length} unique torrents`);
    console.log(`=== END PROWLARR TORRENT SEARCH ===\n`);
    
    res.json({
      musicbrainzItem,
      type,
      totalResults: cleanedResults.length,
      torrents: cleanedResults,
      queriesUsed: searchQueries.slice(0, 3)
    });
    
  } catch (error) {
    console.error(`❌ Unexpected torrent search error:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.log(`=== END PROWLARR TORRENT SEARCH (ERROR) ===\n`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// New endpoint to find the best torrent for a specific track using MusicBrainz ID
// In-memory job tracking for async operations
const asyncJobs = new Map();

// Generate unique job ID
function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

app.post('/api/find-best-torrent', async (req, res) => {
  const { trackTitle, artistName, albumTitle, async: useAsync = true } = req.body;
  
  console.log(`\n🎯 === SMART TORRENT SEARCH ===`);
  console.log(` Track: ${trackTitle}`);
  console.log(`👤 Artist: ${artistName}`);
  console.log(`💿 Album: ${albumTitle}`);
  console.log(`⚡ Async: ${useAsync}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!trackTitle || !artistName) {
    console.log(`❌ Missing required parameters: trackTitle and artistName are required`);
    return res.status(400).json({ error: 'trackTitle and artistName are required' });
  }

  // If async mode, return immediately with job ID
  if (useAsync) {
    const jobId = generateJobId();
    
    // Store job status
    asyncJobs.set(jobId, {
      status: 'pending',
      type: 'find-best-torrent',
      params: { trackTitle, artistName, albumTitle },
      startedAt: new Date().toISOString(),
      progress: 0
    });

    console.log(`🚀 Started async torrent search with job ID: ${jobId}`);
    
    // Return immediately
    res.json({
      success: true,
      async: true,
      jobId: jobId,
      message: 'Torrent search started, check /api/job-status/:jobId for results'
    });

    // Start async processing
    setImmediate(() => processTorrentSearchAsync(jobId, trackTitle, artistName, albumTitle));
    
    return;
  }

  // Synchronous processing (legacy mode)
  try {
    // Step 1: Search MusicBrainz for metadata verification and enhancement
    console.log(`🔍 Step 1: Searching MusicBrainz for verified metadata...`);
    let realMusicBrainzId = null;
    let trackDetails = null;
    
    try {
      const searchQuery = `artist:"${artistName}" AND recording:"${trackTitle}"`;
      console.log(`🎵 MusicBrainz search query: ${searchQuery}`);
      
      const mbSearchResults = await rateLimitedMusicBrainzCall(`${MUSICBRAINZ_CONFIG.baseUrl}/recording`, {
        params: {
          query: searchQuery,
          fmt: 'json',
          limit: 10 // Get more results to find best match
        },
        headers: {
          'User-Agent': MUSICBRAINZ_CONFIG.userAgent
        },
        timeout: 10000
      });
      
      if (mbSearchResults.data.recordings && mbSearchResults.data.recordings.length > 0) {
        // Find the best match (exact title match preferred)
        let bestMatch = mbSearchResults.data.recordings[0]; // Default to first result
        
        for (const recording of mbSearchResults.data.recordings) {
          // Prefer exact title matches
          if (recording.title.toLowerCase() === trackTitle.toLowerCase()) {
            bestMatch = recording;
            break;
          }
        }
        
        realMusicBrainzId = bestMatch.id;
        trackDetails = bestMatch;
        
        console.log(`✅ Found MusicBrainz recording UUID: ${realMusicBrainzId}`);
        console.log(`📋 Title: "${bestMatch.title}"`);
        console.log(`� Artist: ${bestMatch['artist-credit']?.[0]?.name || 'Unknown'}`);
        
        // Get additional details with the real UUID
        try {
          const detailsResponse = await rateLimitedMusicBrainzCall(`${MUSICBRAINZ_CONFIG.baseUrl}/recording/${realMusicBrainzId}`, {
            params: {
              fmt: 'json',
              inc: 'artist-credits+releases+isrcs'
            },
            headers: {
              'User-Agent': MUSICBRAINZ_CONFIG.userAgent
            },
            timeout: 10000
          });
          trackDetails = detailsResponse.data;
          console.log(`✅ Enhanced track details retrieved`);
        } catch (detailsError) {
          console.log(`⚠️ Could not get enhanced details: ${detailsError.message}`);
          // Continue with basic details
        }
        
      } else {
        console.log(`⚠️ No MusicBrainz matches found for "${artistName}" - "${trackTitle}"`);
      }
    } catch (mbSearchError) {
      console.log(`⚠️ MusicBrainz search failed: ${mbSearchError.response?.status} ${mbSearchError.message}`);
    }

    // Step 2: Build enhanced search queries using MusicBrainz metadata (not UUID)
    console.log(`🔍 Step 2: Building enhanced torrent search queries...`);
    const searchQueries = [];
    
    // Use verified/enhanced metadata from MusicBrainz for better searches
    let enhancedArtistName = artistName;
    let enhancedTrackTitle = trackTitle;
    let enhancedAlbumTitle = albumTitle;
    
    if (trackDetails) {
      // Use official artist name from MusicBrainz
      if (trackDetails['artist-credit']?.[0]?.name) {
        enhancedArtistName = trackDetails['artist-credit'][0].name;
        console.log(`✅ Using verified artist name: "${enhancedArtistName}"`);
      }
      
      // Use official track title from MusicBrainz
      if (trackDetails.title) {
        enhancedTrackTitle = trackDetails.title;
        console.log(`✅ Using verified track title: "${enhancedTrackTitle}"`);
      }
      
      // Use release title from MusicBrainz if available
      if (trackDetails.releases?.[0]?.title) {
        enhancedAlbumTitle = trackDetails.releases[0].title;
        console.log(`✅ Using verified album title: "${enhancedAlbumTitle}"`);
      }
    }
    
    // Primary searches with enhanced metadata
    if (enhancedArtistName && enhancedTrackTitle) {
      searchQueries.push(`"${enhancedArtistName}" "${enhancedTrackTitle}"`);
      searchQueries.push(`${enhancedArtistName} ${enhancedTrackTitle}`);
      
      // Add variations for better matching
      searchQueries.push(`"${enhancedTrackTitle}" "${enhancedArtistName}"`);
      searchQueries.push(`${enhancedTrackTitle} ${enhancedArtistName}`);
    }
    
    // Include enhanced album if available
    if (enhancedAlbumTitle && enhancedArtistName && enhancedTrackTitle) {
      searchQueries.push(`"${enhancedArtistName}" "${enhancedTrackTitle}" "${enhancedAlbumTitle}"`);
      searchQueries.push(`${enhancedArtistName} ${enhancedTrackTitle} ${enhancedAlbumTitle}`);
      searchQueries.push(`"${enhancedArtistName}" "${enhancedAlbumTitle}"`);
    }
    
    // Add ISRC codes for precise matching (some private trackers support this)
    if (trackDetails?.isrcs?.length > 0) {
      trackDetails.isrcs.forEach(isrc => {
        searchQueries.push(`"${isrc}"`);
        searchQueries.push(isrc);
      });
      console.log(`✅ Added ${trackDetails.isrcs.length} ISRC codes for enhanced matching`);
    }
    
    // Add alternative artist names from MusicBrainz
    if (trackDetails?.['artist-credit']?.length > 1) {
      trackDetails['artist-credit'].forEach(artistCredit => {
        if (artistCredit.name && artistCredit.name !== enhancedArtistName && enhancedTrackTitle) {
          searchQueries.push(`"${artistCredit.name}" "${enhancedTrackTitle}"`);
        }
      });
    }
    
    // Fallback to original input if no MusicBrainz data
    if (!trackDetails && artistName && trackTitle) {
      console.log(`⚠️ No MusicBrainz verification - using original search terms`);
      searchQueries.push(`"${artistName}" "${trackTitle}"`);
      searchQueries.push(`${artistName} ${trackTitle}`);
    }
    
    console.log(`🔍 Will search with ${searchQueries.length} queries:`, searchQueries.slice(0, 3).map(q => `"${q}"`).join(', ') + (searchQueries.length > 3 ? '...' : ''));

    // 3. Search Prowlarr with multiple queries
    let allTorrents = [];
    
    for (const query of searchQueries.slice(0, 6)) { // Limit to first 6 queries
      try {
        console.log(`🔍 Searching Prowlarr: "${query}"`);
        
        const response = await axios.get(`${PROWLARR_CONFIG.baseUrl}/search`, {
          params: {
            query: query,
            categories: [3000, 3010, 3020, 3030, 3040], // Music categories
            type: 'search'
          },
          headers: {
            'X-Api-Key': PROWLARR_CONFIG.apiKey
          },
          timeout: 15000
        });

        if (response.data && Array.isArray(response.data)) {
          console.log(`📦 Found ${response.data.length} results for "${query}"`);
          allTorrents.push(...response.data);
        }
      } catch (searchError) {
        console.log(`⚠️ Search failed for "${query}": ${searchError.message}`);
        continue;
      }
    }

    console.log(`📦 Total torrents collected: ${allTorrents.length}`);

    if (allTorrents.length === 0) {
      console.log(`❌ No torrents found`);
      return res.json({
        success: false,
        message: 'No torrents found for this track',
        bestTorrent: null
      });
    }

    // 4. Apply smart filtering and scoring
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000));
    
    const scoredTorrents = allTorrents
      .filter(torrent => {
        // Filter out torrents newer than 2 days
        const publishDate = new Date(torrent.publishDate);
        const isOldEnough = publishDate <= twoDaysAgo;
        
        // Filter out torrents with 0 seeders (likely dead)
        const seeders = parseInt(torrent.seeders) || 0;
        const hasActiveSeeder = seeders > 0;
        
        if (!hasActiveSeeder) {
          console.log(`🚫 Skipping torrent with 0 seeders: ${torrent.title?.substring(0, 50)}...`);
        }
        
        return isOldEnough && hasActiveSeeder;
      })
      .map(torrent => {
        let score = 0;
        const title = (torrent.title || '').toLowerCase();
        const trackLower = trackTitle.toLowerCase();
        const artistLower = (artistName || '').toLowerCase();
        
        // Seeder score (primary factor)
        const seeders = parseInt(torrent.seeders) || 0;
        score += seeders * 10; // 10 points per seeder
        
        // Title similarity score
        const titleWords = trackLower.split(/\s+/);
        const matchedWords = titleWords.filter(word => 
          word.length > 2 && title.includes(word)
        ).length;
        const titleSimilarity = titleWords.length > 0 ? matchedWords / titleWords.length : 0;
        score += titleSimilarity * 1000; // Up to 1000 points for perfect title match
        
        // Artist similarity score
        if (artistLower && title.includes(artistLower)) {
          score += 500; // 500 points for artist match
        }
        
        // Album similarity score
        if (albumTitle) {
          const albumLower = albumTitle.toLowerCase();
          if (title.includes(albumLower)) {
            score += 300; // 300 points for album match
          }
        }
        
        // Audio format preference (FLAC > MP3 > others)
        if (title.includes('flac')) {
          score += 200;
        } else if (title.includes('mp3')) {
          score += 100;
        }
        
        // Penalty for very large files (likely albums, not singles)
        const sizeGB = parseFloat(torrent.size) || 0;
        if (sizeGB > 500) { // Larger than 500MB, probably an album
          score -= 200;
        }
        
        // Age bonus (older = more stable)
        const ageInDays = (now - new Date(torrent.publishDate)) / (24 * 60 * 60 * 1000);
        if (ageInDays > 30) {
          score += 50; // Bonus for torrents older than 30 days
        }
        
        // Leecher ratio (prefer torrents with good seed/leech ratio)
        const leechers = parseInt(torrent.leechers) || 0;
        if (seeders > 0 && leechers > 0) {
          const ratio = seeders / leechers;
          if (ratio > 2) {
            score += 100; // Good ratio bonus
          }
        }
        
        return {
          ...torrent,
          score: Math.round(score),
          titleSimilarity: Math.round(titleSimilarity * 100),
          seeders: seeders,
          ageInDays: Math.round(ageInDays)
        };
      })
      .filter(torrent => torrent.score > 0) // Remove torrents with zero or negative score
      .sort((a, b) => b.score - a.score); // Sort by score (highest first)

    console.log(`🎯 Scored and filtered torrents: ${scoredTorrents.length}`);
    
    if (scoredTorrents.length === 0) {
      console.log(`❌ No suitable torrents found after filtering`);
      return res.json({
        success: false,
        message: 'No suitable torrents found (all too new or low quality)',
        bestTorrent: null
      });
    }

    // 5. Return the best torrent
    const bestTorrent = scoredTorrents[0];
    const topTorrents = scoredTorrents.slice(0, 5); // Return top 5 for reference
    
    console.log(`🏆 Best torrent selected:`);
    console.log(`   Title: ${bestTorrent.title}`);
    console.log(`   Score: ${bestTorrent.score}`);
    console.log(`   Seeders: ${bestTorrent.seeders}`);
    console.log(`   Title similarity: ${bestTorrent.titleSimilarity}%`);
    console.log(`   Age: ${bestTorrent.ageInDays} days`);
    
    console.log(`=== END FIND BEST TORRENT ===\n`);
    
    res.json({
      success: true,
      bestTorrent: bestTorrent,
      alternativeTorrents: topTorrents.slice(1), // Other good options
      searchQueries: searchQueries.slice(0, 6),
      totalFound: allTorrents.length,
      afterFiltering: scoredTorrents.length,
      trackDetails: trackDetails ? {
        title: trackDetails.title,
        length: trackDetails.length,
        isrcs: trackDetails.isrcs
      } : null
    });

  } catch (error) {
    console.error(`❌ Error finding best torrent:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.log(`=== END FIND BEST TORRENT (ERROR) ===\n`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Async torrent search processing function
async function processTorrentSearchAsync(jobId, trackTitle, artistName, albumTitle) {
  try {
    console.log(`\n🚀 === ASYNC TORRENT SEARCH (${jobId}) ===`);
    
    // Update job status
    asyncJobs.set(jobId, {
      ...asyncJobs.get(jobId),
      status: 'processing',
      progress: 10
    });

    // Step 1: Search MusicBrainz for metadata verification and enhancement
    console.log(`🔍 Step 1: Searching MusicBrainz for verified metadata...`);
    let realMusicBrainzId = null;
    let trackDetails = null;
    
    // Update progress
    asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 20 });
    
    try {
      const searchQuery = `artist:"${artistName}" AND recording:"${trackTitle}"`;
      console.log(`🎵 MusicBrainz search query: ${searchQuery}`);
      
      const mbSearchResults = await rateLimitedMusicBrainzCall(`${MUSICBRAINZ_CONFIG.baseUrl}/recording`, {
        params: {
          query: searchQuery,
          fmt: 'json',
          limit: 10
        },
        headers: {
          'User-Agent': MUSICBRAINZ_CONFIG.userAgent
        },
        timeout: 10000
      });
      
      if (mbSearchResults.data.recordings && mbSearchResults.data.recordings.length > 0) {
        let bestMatch = mbSearchResults.data.recordings[0];
        
        for (const recording of mbSearchResults.data.recordings) {
          if (recording.title.toLowerCase() === trackTitle.toLowerCase()) {
            bestMatch = recording;
            break;
          }
        }
        
        realMusicBrainzId = bestMatch.id;
        trackDetails = bestMatch;
        
        console.log(`✅ Found MusicBrainz recording UUID: ${realMusicBrainzId}`);
      }
    } catch (mbError) {
      console.warn(`⚠️ MusicBrainz search failed:`, mbError.message);
    }

    // Update progress
    asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 40 });

    // Step 2: Build enhanced search queries
    console.log(`🔍 Step 2: Building enhanced search queries...`);
    const searchQueries = [];
    let enhancedArtistName = artistName;
    let enhancedTrackTitle = trackTitle;
    let enhancedAlbumTitle = albumTitle;
    
    if (trackDetails) {
      enhancedTrackTitle = trackDetails.title;
      if (trackDetails['artist-credit']?.[0]?.name) {
        enhancedArtistName = trackDetails['artist-credit'][0].name;
      }
      
      if (trackDetails.releases?.[0]?.title) {
        enhancedAlbumTitle = trackDetails.releases[0].title;
      }
    }
    
    // Build search queries (same logic as before)
    if (enhancedArtistName && enhancedTrackTitle) {
      searchQueries.push(`"${enhancedArtistName}" "${enhancedTrackTitle}"`);
      searchQueries.push(`${enhancedArtistName} ${enhancedTrackTitle}`);
      searchQueries.push(`"${enhancedTrackTitle}" "${enhancedArtistName}"`);
      searchQueries.push(`${enhancedTrackTitle} ${enhancedArtistName}`);
    }
    
    if (enhancedAlbumTitle && enhancedArtistName && enhancedTrackTitle) {
      searchQueries.push(`"${enhancedArtistName}" "${enhancedTrackTitle}" "${enhancedAlbumTitle}"`);
      searchQueries.push(`${enhancedArtistName} ${enhancedTrackTitle} ${enhancedAlbumTitle}`);
      searchQueries.push(`"${enhancedArtistName}" "${enhancedAlbumTitle}"`);
    }

    // Update progress
    asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 50 });

    // Step 3: Search torrents
    console.log(`🔍 Step 3: Searching torrents with enhanced queries...`);
    const allTorrents = await searchMultipleTorrentQueries(searchQueries);
    
    // Update progress
    asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 70 });

    // Step 4: Score and filter torrents
    console.log(`🔍 Step 4: Scoring and filtering torrents...`);
    const scoredTorrents = scoreAndFilterTorrents(allTorrents, enhancedArtistName, enhancedTrackTitle, enhancedAlbumTitle);
    
    // Update progress
    asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 90 });

    if (scoredTorrents.length === 0) {
      asyncJobs.set(jobId, {
        ...asyncJobs.get(jobId),
        status: 'completed',
        progress: 100,
        result: {
          success: false,
          message: 'No suitable torrents found'
        }
      });
      return;
    }

    const topTorrents = scoredTorrents.slice(0, 10);
    const bestTorrent = topTorrents[0];

    // Update progress and complete
    asyncJobs.set(jobId, {
      ...asyncJobs.get(jobId),
      status: 'completed',
      progress: 100,
      completedAt: new Date().toISOString(),
      result: {
        success: true,
        bestTorrent: bestTorrent,
        alternativeTorrents: topTorrents.slice(1),
        searchQueries: searchQueries.slice(0, 6),
        totalFound: allTorrents.length,
        afterFiltering: scoredTorrents.length,
        trackDetails: trackDetails ? {
          title: trackDetails.title,
          length: trackDetails.length,
          isrcs: trackDetails.isrcs
        } : null
      }
    });

    console.log(`✅ Async torrent search completed for job ${jobId}`);
    console.log(`🏆 Best torrent: ${bestTorrent.title} (Score: ${bestTorrent.score})`);

  } catch (error) {
    console.error(`❌ Error in async torrent search (${jobId}):`, error);
    asyncJobs.set(jobId, {
      ...asyncJobs.get(jobId),
      status: 'failed',
      progress: 100,
      error: error.message,
      completedAt: new Date().toISOString()
    });
  }
}

// Helper function to search multiple torrent queries
async function searchMultipleTorrentQueries(searchQueries) {
  const allTorrents = [];
  
  for (const query of searchQueries.slice(0, 6)) {
    try {
      const results = await searchProwlarr(query);
      allTorrents.push(...results);
    } catch (error) {
      console.warn(`⚠️ Search failed for query: ${query}`, error.message);
    }
  }
  
  return allTorrents;
}

// Helper function to score and filter torrents
function scoreAndFilterTorrents(torrents, artistName, trackTitle, albumTitle) {
  // Filter for active torrents
  const activeTorrents = torrents.filter(torrent => (torrent.seeders || 0) > 0);
  
  // Score torrents (same logic as before)
  const scoredTorrents = activeTorrents.map(torrent => {
    let score = 0;
    const seeders = torrent.seeders || 0;
    const title = (torrent.title || '').toLowerCase();
    
    // Seeder score
    if (seeders > 50) score += 100;
    else if (seeders > 20) score += 80;
    else if (seeders > 10) score += 60;
    else if (seeders > 5) score += 40;
    else if (seeders > 0) score += 20;
    
    // Title similarity
    const searchTerms = `${artistName} ${trackTitle} ${albumTitle || ''}`.toLowerCase();
    const searchWords = searchTerms.split(' ').filter(word => word.length > 2);
    
    searchWords.forEach(word => {
      if (title.includes(word)) {
        score += 15;
      }
    });
    
    return { ...torrent, score };
  });
  
  return scoredTorrents.sort((a, b) => b.score - a.score);
}

// Job status endpoint
app.get('/api/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  const job = asyncJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
  
  // Clean up completed jobs after they're retrieved
  if (job.status === 'completed' || job.status === 'failed') {
    setTimeout(() => {
      asyncJobs.delete(jobId);
    }, 300000); // Keep for 5 minutes
  }
});

// New endpoint to get artist albums from MusicBrainz
app.post('/api/artist-albums', async (req, res) => {
  const { artistId, artistName } = req.body;
  
  console.log(`\n💿 === ARTIST ALBUMS SEARCH ===`);
  console.log(`🎤 Artist ID: ${artistId}`);
  console.log(`🎤 Artist Name: ${artistName}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!artistId) {
    console.log(`❌ Missing artistId`);
    return res.status(400).json({ error: 'artistId is required' });
  }
  
  try {
    // Search MusicBrainz for artist's releases
    console.log(`🔍 Fetching albums for artist ${artistId} from MusicBrainz`);
    
    const response = await axios.get(`${MUSICBRAINZ_CONFIG.baseUrl}/release`, {
      headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
      params: { 
        artist: artistId,
        fmt: 'json',
        limit: 50,
        offset: 0,
        'type': 'album', // Filter to albums only
        'status': 'official' // Official releases only
      }
    });
    
    const releases = response.data.releases || [];
    
    // Clean and format album data
    const albums = releases.map(release => ({
      id: release.id,
      title: release.title,
      date: release.date,
      status: release.status,
      'track-count': release['track-count'],
      country: release.country,
      disambiguation: release.disambiguation,
      packaging: release.packaging,
      'artist-credit': release['artist-credit']
    })).filter(album => album.title); // Filter out albums without titles
    
    // Sort by release date (newest first)
    albums.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date) - new Date(a.date);
    });
    
    console.log(`✅ Found ${albums.length} albums for ${artistName}`);
    console.log(`=== END ARTIST ALBUMS SEARCH ===\n`);
    
    res.json({
      artistId,
      artistName,
      totalAlbums: albums.length,
      albums: albums
    });
    
  } catch (error) {
    console.error(`❌ Error fetching artist albums:`);
    console.error(`   Message: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data)}`);
    }
    console.log(`=== END ARTIST ALBUMS SEARCH (ERROR) ===\n`);
    res.status(500).json({ error: 'Failed to fetch artist albums' });
  }
});

// New endpoint to get detailed artist information
app.post('/api/artist-details', async (req, res) => {
  const { artistId, artistName } = req.body;
  
  console.log(`\n🎤 === ARTIST DETAILS SEARCH ===`);
  console.log(`🎤 Artist ID: ${artistId}`);
  console.log(`🎤 Artist Name: ${artistName}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!artistId) {
    console.log(`❌ Missing artistId`);
    return res.status(400).json({ error: 'artistId is required' });
  }

  try {
    let artist = null;
    
    // Try to fetch detailed artist information with retries
    try {
      console.log(`🔍 Fetching detailed artist info for ${artistId} (with retries)`);
      console.log(`🌐 URL: ${MUSICBRAINZ_CONFIG.baseUrl}/artist/${artistId}`);
      
      const artistResponse = await retryApiCall(async () => {
        return await axios.get(`${MUSICBRAINZ_CONFIG.baseUrl}/artist/${artistId}`, {
          headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
          params: { 
            fmt: 'json',
            inc: 'annotation+tags'
          }
        });
      }, 10, 1000); // 10 attempts, starting with 1 second delay

      artist = artistResponse.data;
      console.log(`✅ Found detailed artist info for ${artistName}`);
    } catch (artistError) {
      console.log(`⚠️ Failed to fetch detailed artist info after retries, using basic info`);
      console.log(`   Final error: ${artistError.message}`);
      
      // Fallback: create basic artist object
      artist = {
        id: artistId,
        name: artistName,
        type: 'Artist',
        annotation: null,
        tags: []
      };
    }

    // Get all artist releases (albums, EPs, singles, etc.) with retries
    console.log(`🔍 Fetching all releases for artist ${artistId} (with retries)`);
    
    // Fetch different types of releases
    const releaseTypes = ['album', 'ep', 'single', 'broadcast', 'other'];
    let allReleases = [];
    
    for (const type of releaseTypes) {
      try {
        console.log(`📀 Fetching ${type}s for ${artistName}`);
        
        const releasesResponse = await retryApiCall(async () => {
          return await axios.get(`${MUSICBRAINZ_CONFIG.baseUrl}/release`, {
            headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
            params: { 
              artist: artistId,
              fmt: 'json',
              limit: 100,
              offset: 0,
              'type': type,
              'status': 'official'
            }
          });
        }, 5, 1000); // 5 attempts per type

        const releases = releasesResponse.data.releases || [];
        console.log(`✅ Found ${releases.length} ${type}s for ${artistName}`);
        
        // Add release type to each release
        releases.forEach(release => {
          release.releaseType = type;
        });
        
        allReleases = allReleases.concat(releases);
        
        // Small delay between requests to be respectful
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.log(`⚠️ Failed to fetch ${type}s: ${error.message}`);
      }
    }
    
    console.log(`📀 Found ${allReleases.length} total releases for ${artistName}`);
    
    // Deduplicate releases by title and keep the earliest release of each type
    const releasesMap = new Map();
    allReleases.forEach(release => {
      const key = `${release.title.toLowerCase().trim()}-${release.releaseType}`;
      if (!releasesMap.has(key) || (release.date && release.date < releasesMap.get(key).date)) {
        releasesMap.set(key, {
          id: release.id,
          title: release.title,
          date: release.date,
          trackCount: release['track-count'],
          status: release.status,
          barcode: release.barcode,
          releaseType: release.releaseType,
          country: release.country
        });
      }
    });

    const allUniqueReleases = Array.from(releasesMap.values())
      .sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
      });

    // Categorize releases by type
    const releasesByType = {
      albums: allUniqueReleases.filter(r => r.releaseType === 'album'),
      eps: allUniqueReleases.filter(r => r.releaseType === 'ep'),
      singles: allUniqueReleases.filter(r => r.releaseType === 'single'),
      other: allUniqueReleases.filter(r => ['broadcast', 'other'].includes(r.releaseType))
    };

    console.log(`📀 Categorized releases for ${artistName}:`);
    console.log(`   Albums: ${releasesByType.albums.length}`);
    console.log(`   EPs: ${releasesByType.eps.length}`);
    console.log(`   Singles: ${releasesByType.singles.length}`);
    console.log(`   Other: ${releasesByType.other.length}`);

    // Try to get a banner image from releases with retries
    let bannerImage = null;
    // Try albums first, then EPs, then singles
    const releasesToTry = [...releasesByType.albums, ...releasesByType.eps, ...releasesByType.singles].slice(0, 5);
    
    for (const release of releasesToTry) {
      try {
        console.log(`🖼️ Trying to fetch banner image from ${release.releaseType}: ${release.title}`);
        
        const coverArtResponse = await retryApiCall(async () => {
          return await axios.get(`https://coverartarchive.org/release/${release.id}`, {
            timeout: 10000
          });
        }, 3, 500); // Only 3 attempts for images with shorter delay
        
        if (coverArtResponse.data.images && coverArtResponse.data.images.length > 0) {
          const image = coverArtResponse.data.images[0];
          if (image.image) {
            bannerImage = image.image;
            console.log(`🖼️ Found banner image from ${release.releaseType}: ${release.title}`);
            break;
          }
        }
      } catch (imageError) {
        console.log(`🔍 No banner image found for ${release.releaseType}: ${release.title}`);
        // Continue to next release
      }
    }

    // Extract biography from annotation or relationships
    let biography = artist.annotation || '';
    if (!biography && artist.relationships) {
      // Try to find Wikipedia or other biographical relationships
      const bioRelations = artist.relationships.filter(rel => 
        rel.type === 'wikipedia' || rel.type === 'biography' || rel.type === 'discogs'
      );
      if (bioRelations.length > 0) {
        biography = `For more information, visit: ${bioRelations[0].url?.resource || 'external sources'}`;
      }
    }
    
    if (!biography) {
      biography = `${artistName} is ${artist.type || 'an artist'}${artist.country ? ` from ${artist.country}` : ''}.${artist['life-span']?.begin ? ` Active since ${artist['life-span'].begin}.` : ''}`;
    }

    const result = {
      id: artist.id,
      name: artist.name,
      type: artist.type,
      country: artist.country,
      lifeSpan: artist['life-span'],
      biography: biography,
      bannerImage: bannerImage,
      // Legacy field for backward compatibility
      albums: releasesByType.albums,
      // New categorized releases without torrents initially
      releases: releasesByType,
      totalReleases: allUniqueReleases.length,
      tags: artist.tags?.map(tag => tag.name) || [],
      disambiguation: artist.disambiguation,
      // Indicate that torrent pre-loading is in progress
      torrentPreloadingInProgress: true
    };

    console.log(`✅ Artist details compiled for ${artistName} - sending response immediately`);
    console.log(`🔍 Starting background torrent pre-loading for ${releasesByType.albums.length} albums`);
    console.log(`=== END ARTIST DETAILS SEARCH (Response Sent) ===\n`);
    
    // Send response immediately
    res.json(result);

    // Start torrent pre-loading in the background (non-blocking)
    setImmediate(async () => {
      try {
        console.log(`\n🚀 === BACKGROUND TORRENT PRE-LOADING ===`);
        console.log(`🎤 Artist: ${artistName}`);
        console.log(`📀 Albums to process: ${releasesByType.albums.length}`);
        console.log(`🕐 Started at: ${new Date().toISOString()}`);

        const albumsWithTorrents = await Promise.all(
          releasesByType.albums.map(async (album) => {
            try {
              console.log(`🔍 Finding torrents for album: ${album.title}`);
              
              // Use the existing searchProwlarr function
              const searchQuery = `${artistName} ${album.title}`;
              let torrents = await searchProwlarr(searchQuery);

              console.log(`📦 Found ${torrents.length} total torrents for ${album.title}`);

              // Filter for active torrents (seeders > 0)
              torrents = torrents.filter(torrent => {
                const seeders = torrent.seeders || 0;
                return seeders > 0;
              });

              console.log(`🌱 Found ${torrents.length} active torrents (seeders > 0) for ${album.title}`);

              if (torrents.length === 0) {
                console.log(`⚠️ No active torrents found for ${album.title}`);
                return { ...album, torrents: [] };
              }

              // Score and sort torrents using the same logic as find-best-torrent
              const scoredTorrents = torrents.map(torrent => {
                let score = 0;
                const seeders = torrent.seeders || 0;
                const size = torrent.size || 0;
                const title = (torrent.title || '').toLowerCase();
                const searchTermsLower = searchQuery.toLowerCase();

                // Seeder score (most important factor)
                if (seeders > 50) score += 100;
                else if (seeders > 20) score += 80;
                else if (seeders > 10) score += 60;
                else if (seeders > 5) score += 40;
                else if (seeders > 0) score += 20;

                // Title similarity
                const queryWords = searchTermsLower.split(' ');
                const titleWords = title.split(' ');
                
                queryWords.forEach(word => {
                  if (word.length > 2) {
                    if (title.includes(word)) {
                      score += 15;
                      if (titleWords.includes(word)) {
                        score += 10; // Exact word match bonus
                      }
                    }
                  }
                });

                // Size preference (reasonable album sizes)
                if (size > 0) {
                  const sizeMB = size / (1024 * 1024);
                  if (sizeMB >= 50 && sizeMB <= 500) {
                    score += 10; // Good size range for albums
                  } else if (sizeMB > 500 && sizeMB <= 1000) {
                    score += 5; // Acceptable size
                  }
                }

                // Age preference (prefer newer uploads)
                if (torrent.publishDate) {
                  const ageMs = Date.now() - new Date(torrent.publishDate).getTime();
                  const ageDays = ageMs / (1000 * 60 * 60 * 24);
                  if (ageDays < 30) score += 5;
                  else if (ageDays < 90) score += 3;
                  else if (ageDays < 365) score += 1;
                }

                return { ...torrent, score };
              });

              // Sort by score and take top 20
              const topTorrents = scoredTorrents
                .sort((a, b) => b.score - a.score)
                .slice(0, 20);

              console.log(`🏆 Top torrent for ${album.title}: ${topTorrents[0]?.title} (Score: ${topTorrents[0]?.score}, Seeders: ${topTorrents[0]?.seeders})`);

              // Resolve magnet URLs and add to WebTorrent for immediate availability
              console.log(`🧲 Resolving magnet URLs for ${topTorrents.length} torrents...`);
              const torrentsWithMagnets = await Promise.all(
                topTorrents.map(async (torrent) => {
                  try {
                    // Get the download URL (could be Prowlarr download URL or direct magnet)
                    const downloadUrl = torrent.url || torrent.magnetUrl || torrent.magnet || torrent.downloadUrl || torrent.link;
                    
                    if (!downloadUrl) {
                      console.warn(`⚠️ No download URL found for torrent: ${torrent.title}`);
                      return { ...torrent, magnetUrl: null, webTorrentReady: false };
                    }

                    // Resolve to actual magnet URL
                    const resolvedMagnetUrl = await resolveMagnetUrl(downloadUrl);
                    
                    if (!resolvedMagnetUrl || !resolvedMagnetUrl.startsWith('magnet:')) {
                      console.warn(`⚠️ Could not resolve magnet URL for: ${torrent.title}`);
                      return { ...torrent, magnetUrl: null, webTorrentReady: false };
                    }

                    // Add to WebTorrent client for immediate availability (but don't wait for ready)
                    console.log(`🔄 Adding ${torrent.title} to WebTorrent client...`);
                    
                    // Check if already in WebTorrent
                    let isAlreadyAdded = activeTorrents.has(resolvedMagnetUrl);
                    
                    if (!isAlreadyAdded) {
                      try {
                        // Add torrent to client (don't wait for it to be ready)
                        const addedTorrent = torrentClient.add(resolvedMagnetUrl, {
                          destroyStoreOnDestroy: true
                        });

                        // Store immediately
                        activeTorrents.set(resolvedMagnetUrl, addedTorrent);
                        
                        // Set up event handlers for when it's ready
                        addedTorrent.on('ready', () => {
                          console.log(`✅ Pre-loaded torrent ready: ${torrent.title}`);
                        });

                        addedTorrent.on('error', (err) => {
                          console.warn(`⚠️ Pre-loaded torrent error: ${torrent.title}:`, err.message);
                          activeTorrents.delete(resolvedMagnetUrl);
                        });

                        console.log(`🎯 Added ${torrent.title} to WebTorrent (will load in background)`);
                      } catch (addError) {
                        console.warn(`⚠️ Error adding torrent to WebTorrent: ${addError.message}`);
                      }
                    } else {
                      console.log(`♻️ Torrent already in WebTorrent: ${torrent.title}`);
                    }

                    return { 
                      ...torrent, 
                      magnetUrl: resolvedMagnetUrl,
                      webTorrentReady: true,
                      originalDownloadUrl: downloadUrl
                    };

                  } catch (resolveError) {
                    console.error(`❌ Error resolving magnet for ${torrent.title}:`, resolveError.message);
                    return { ...torrent, magnetUrl: null, webTorrentReady: false };
                  }
                })
              );

              console.log(`🧲 Resolved ${torrentsWithMagnets.filter(t => t.magnetUrl).length}/${torrentsWithMagnets.length} magnet URLs for ${album.title}`);

              return { ...album, torrents: torrentsWithMagnets };

            } catch (error) {
              console.error(`❌ Error pre-loading torrents for album ${album.title}:`, error.message);
              return { ...album, torrents: [] };
            }
          })
        );

        console.log(`✅ Background torrent pre-loading completed for ${artistName}`);
        console.log(`🔍 Pre-loaded torrents for ${albumsWithTorrents.length} albums`);
        console.log(`🕐 Completed at: ${new Date().toISOString()}`);
        console.log(`=== END BACKGROUND TORRENT PRE-LOADING ===\n`);

        // Store the pre-loaded data in memory for later retrieval
        preloadedAlbumTorrents.set(artist.id, {
          albums: albumsWithTorrents,
          timestamp: new Date().toISOString()
        });
        
        console.log(`💾 Cached pre-loaded torrents for artist ${artist.id}`);

      } catch (error) {
        console.error(`❌ Error in background torrent pre-loading:`, error);
        console.log(`=== END BACKGROUND TORRENT PRE-LOADING (ERROR) ===\n`);
      }
    });
    
  } catch (error) {
    console.error(`❌ Error fetching artist details:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Status: ${error.response?.status || 'N/A'}`);
    console.error(`=== END ARTIST DETAILS SEARCH ===\n`);
    
    res.status(500).json({ 
      error: 'Failed to fetch artist details',
      message: error.message 
    });
  }
});

// In-memory cache for pre-loaded album torrents
const preloadedAlbumTorrents = new Map();

// Endpoint to get pre-loaded album torrents
app.get('/api/artist-torrents/:artistId', async (req, res) => {
  const { artistId } = req.params;
  
  console.log(`\n🔍 === FETCHING PRE-LOADED TORRENTS ===`);
  console.log(`🎤 Artist ID: ${artistId}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  try {
    const preloadedData = preloadedAlbumTorrents.get(artistId);
    
    if (preloadedData) {
      console.log(`✅ Found pre-loaded torrents for artist ${artistId}`);
      console.log(`📀 Albums with torrents: ${preloadedData.albums.length}`);
      res.json({
        success: true,
        albums: preloadedData.albums,
        preloadedAt: preloadedData.timestamp
      });
    } else {
      console.log(`⚠️ No pre-loaded torrents found for artist ${artistId}`);
      res.json({
        success: false,
        message: 'No pre-loaded torrents available yet'
      });
    }
  } catch (error) {
    console.error(`❌ Error fetching pre-loaded torrents:`, error);
    res.status(500).json({ 
      error: 'Failed to fetch pre-loaded torrents',
      message: error.message 
    });
  }
  
  console.log(`=== END FETCHING PRE-LOADED TORRENTS ===\n`);
});

// New endpoint to get detailed album information including track list
app.post('/api/album-details', async (req, res) => {
  const { albumId, albumTitle, artistName } = req.body;
  
  console.log(`\n💿 === ALBUM DETAILS SEARCH ===`);
  console.log(`💿 Album ID: ${albumId}`);
  console.log(`💿 Album Title: ${albumTitle}`);
  console.log(`🎤 Artist Name: ${artistName}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!albumId) {
    console.log(`❌ Missing albumId`);
    return res.status(400).json({ error: 'albumId is required' });
  }

  try {
    // Fetch detailed album information with track recordings
    console.log(`🔍 Fetching detailed album info for ${albumId} (with retries)`);
    console.log(`🌐 URL: ${MUSICBRAINZ_CONFIG.baseUrl}/release/${albumId}`);
    
    const albumResponse = await retryApiCall(async () => {
      return await axios.get(`${MUSICBRAINZ_CONFIG.baseUrl}/release/${albumId}`, {
        headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
        params: { 
          fmt: 'json',
          inc: 'recordings+artist-credits+labels+release-groups'
        }
      });
    }, 10, 1000);

    const album = albumResponse.data;
    console.log(`✅ Found detailed album info for ${albumTitle}`);

    // Extract track information
    let tracks = [];
    if (album.media && album.media.length > 0) {
      // Combine tracks from all media (discs)
      album.media.forEach((medium, mediaIndex) => {
        if (medium.tracks) {
          medium.tracks.forEach(track => {
            tracks.push({
              id: track.id,
              position: track.position,
              title: track.title,
              length: track.length ? formatTrackLength(track.length) : null,
              recording: track.recording,
              artist: track['artist-credit'] ? 
                track['artist-credit'].map(ac => ac.name).join(', ') : 
                artistName,
              discNumber: mediaIndex + 1,
              discTitle: medium.title
            });
          });
        }
      });
    }

    console.log(`🎵 Found ${tracks.length} tracks for ${albumTitle}`);

    // Try to get album cover art
    let coverArt = null;
    try {
      console.log(`🖼️ Fetching cover art for album ${albumId}`);
      
      const coverArtResponse = await retryApiCall(async () => {
        return await axios.get(`https://coverartarchive.org/release/${albumId}`, {
          timeout: 10000
        });
      }, 3, 500);
      
      if (coverArtResponse.data.images && coverArtResponse.data.images.length > 0) {
        // Get the front cover or first available image
        const frontCover = coverArtResponse.data.images.find(img => 
          img.front === true || img.types.includes('Front')
        ) || coverArtResponse.data.images[0];
        
        if (frontCover) {
          coverArt = frontCover.image;
          console.log(`✅ Found cover art for ${albumTitle}`);
        }
      }
    } catch (coverError) {
      console.log(`🔍 No cover art found for ${albumTitle}`);
    }

    const result = {
      id: album.id,
      title: album.title,
      status: album.status,
      date: album.date,
      country: album.country,
      barcode: album.barcode,
      coverArt: coverArt,
      tracks: tracks,
      trackCount: tracks.length,
      totalLength: tracks.reduce((total, track) => {
        if (track.recording && track.recording.length) {
          return total + track.recording.length;
        }
        return total;
      }, 0),
      labels: album['label-info']?.map(li => li.label?.name).filter(Boolean) || [],
      releaseGroup: album['release-group']
    };

    // Format total album length
    if (result.totalLength > 0) {
      result.totalLengthFormatted = formatTrackLength(result.totalLength);
    }

    console.log(`✅ Album details compiled for ${albumTitle}`);
    console.log(`=== END ALBUM DETAILS SEARCH ===\n`);
    
    res.json(result);
    
  } catch (error) {
    console.error(`❌ Error fetching album details:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Status: ${error.response?.status || 'N/A'}`);
    console.error(`=== END ALBUM DETAILS SEARCH ===\n`);
    
    res.status(500).json({ 
      error: 'Failed to fetch album details',
      message: error.message 
    });
  }
});

// Helper function to format track length from milliseconds to MM:SS
function formatTrackLength(lengthMs) {
  if (!lengthMs) return null;
  
  const totalSeconds = Math.floor(lengthMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// New endpoint to get artist image from MusicBrainz/Cover Art Archive
app.post('/api/artist-image', async (req, res) => {
  const { artistId, artistName } = req.body;
  
  console.log(`\n🖼️  === ARTIST IMAGE SEARCH ===`);
  console.log(`🎤 Artist ID: ${artistId}`);
  console.log(`🎤 Artist Name: ${artistName}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!artistId) {
    console.log(`❌ Missing artistId`);
    return res.status(400).json({ error: 'artistId is required' });
  }

  // Check global attempt limits first
  const now = Date.now();
  
  // Reset global counter if enough time has passed
  if (now - globalImageSearchCounter.resetTime > RESET_INTERVAL) {
    console.log(`⏰ Resetting global image search counter after ${RESET_INTERVAL}ms`);
    globalImageSearchCounter.count = 0;
    globalImageSearchCounter.resetTime = now;
    artistImageSearchCache.clear(); // Also clear individual artist cache
  }
  
  // Check global limit
  if (globalImageSearchCounter.count >= MAX_GLOBAL_IMAGE_SEARCH_ATTEMPTS) {
    console.log(`🌍 Global max attempts (${MAX_GLOBAL_IMAGE_SEARCH_ATTEMPTS}) reached. No more image searches allowed.`);
    console.log(`=== END ARTIST IMAGE SEARCH ===\n`);
    return res.json({
      artistId,
      artistName,
      imageUrl: null,
      source: 'global-limit-reached'
    });
  }

  // Check if we've already searched for this specific artist
  const searchKey = `${artistId}-${artistName}`;
  const attempts = artistImageSearchCache.get(searchKey) || 0;
  
  if (attempts >= MAX_ATTEMPTS_PER_ARTIST) {
    console.log(`🚫 Max search attempts (${MAX_ATTEMPTS_PER_ARTIST}) reached for ${artistName}. Returning null.`);
    console.log(`=== END ARTIST IMAGE SEARCH ===\n`);
    return res.json({
      artistId,
      artistName,
      imageUrl: null,
      source: 'artist-limit-reached'
    });
  }

  // Increment both counters
  artistImageSearchCache.set(searchKey, attempts + 1);
  globalImageSearchCounter.count++;
  console.log(`🔢 Search attempt ${attempts + 1}/${MAX_ATTEMPTS_PER_ARTIST} for ${artistName}`);
  console.log(`🌍 Global attempts: ${globalImageSearchCounter.count}/${MAX_GLOBAL_IMAGE_SEARCH_ATTEMPTS}`);
  
  try {
    // First, try to get artist releases to find cover art
    console.log(`🔍 Fetching releases for artist ${artistId} to find cover art`);
    
    const releasesResponse = await axios.get(`${MUSICBRAINZ_CONFIG.baseUrl}/release`, {
      headers: { 'User-Agent': MUSICBRAINZ_CONFIG.userAgent },
      params: { 
        artist: artistId,
        fmt: 'json',
        limit: 10,
        'type': 'album',
        'status': 'official'
      }
    });

    const releases = releasesResponse.data.releases || [];
    console.log(`📀 Found ${releases.length} releases for ${artistName}`);
    
    // Try to find cover art for the releases
    for (const release of releases.slice(0, 5)) { // Check first 5 releases
      try {
        console.log(`🖼️  Checking cover art for release: ${release.title}`);
        
        const coverArtResponse = await axios.get(`https://coverartarchive.org/release/${release.id}`, {
          timeout: 10000 // 10 second timeout for image loading only
        });
        
        if (coverArtResponse.data.images && coverArtResponse.data.images.length > 0) {
          // Get the front cover or first available image
          const frontCover = coverArtResponse.data.images.find(img => 
            img.front === true || img.types.includes('Front')
          ) || coverArtResponse.data.images[0];
          
          if (frontCover && frontCover.thumbnails && frontCover.thumbnails.small) {
            console.log(`✅ Found cover art for ${artistName}: ${frontCover.thumbnails.small}`);
            // Remove from cache since we found an image successfully
            artistImageSearchCache.delete(searchKey);
            console.log(`=== END ARTIST IMAGE SEARCH ===\n`);
            return res.json({
              artistId,
              artistName,
              imageUrl: frontCover.thumbnails.small,
              source: 'cover-art-archive',
              releaseTitle: release.title
            });
          }
        }
      } catch (coverError) {
        // Continue to next release if cover art not found
        console.log(`🔍 No cover art found for release: ${release.title}`);
      }
      
      // Rate limit between requests
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // If no cover art found, try to get artist art from fanart.tv (if you have API key)
    // For now, we'll return null to use the fallback
    console.log(`❌ No images found for ${artistName}`);
    console.log(`=== END ARTIST IMAGE SEARCH ===\n`);
    
    res.json({
      artistId,
      artistName,
      imageUrl: null,
      source: 'none'
    });
    
  } catch (error) {
    console.error(`❌ Error fetching artist image:`);
    console.error(`   Message: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
    }
    console.log(`=== END ARTIST IMAGE SEARCH (ERROR) ===\n`);
    res.status(500).json({ error: 'Failed to fetch artist image' });
  }
});

// Endpoint to get Prowlarr indexers
app.get('/api/indexers', async (req, res) => {
  console.log(`\n📋 === INDEXERS REQUEST ===`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  try {
    const data = await getProwlarrIndexers();
    
    if (data.error) {
      console.log(`❌ Failed to fetch indexers: ${data.error}`);
      console.log(`=== END INDEXERS REQUEST (ERROR) ===\n`);
      return res.status(500).json({ error: data.error });
    }
    
    console.log(`✅ Indexers fetched successfully`);
    console.log(`=== END INDEXERS REQUEST ===\n`);
    res.json(data);
  } catch (error) {
    console.error(`❌ Unexpected indexers error:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.log(`=== END INDEXERS REQUEST (ERROR) ===\n`);
    res.status(500).json({ error: 'Failed to fetch indexers' });
  }
});

// Legacy scraping endpoint
app.post('/api/scrape', async (req, res) => {
  const { urls, searchTerms } = req.body;
  
  console.log(`\n🕷️ === SCRAPING REQUEST ===`);
  console.log(`📝 URLs: [${urls?.join(', ') || 'none'}]`);
  console.log(`🔍 Search terms: [${searchTerms?.join(', ') || 'none'}]`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!Array.isArray(urls) || !Array.isArray(searchTerms)) {
    console.log(`❌ Invalid request: urls and searchTerms must be arrays`);
    console.log(`=== END SCRAPING REQUEST (ERROR) ===\n`);
    return res.status(400).json({ error: 'urls and searchTerms must be arrays' });
  }
  
  try {
    console.log(`🚀 Starting scraping of ${urls.length} URLs...`);
    const results = await Promise.all(urls.map(url => scrapeAndSearch(url, searchTerms)));
    
    console.log(`✅ Scraping completed successfully`);
    console.log(`📊 Results: ${results.length} processed`);
    console.log(`=== END SCRAPING REQUEST ===\n`);
    
    res.json({ results });
  } catch (error) {
    console.error(`❌ Unexpected scraping error:`);
    console.error(`   Message: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.log(`=== END SCRAPING REQUEST (ERROR) ===\n`);
    res.status(500).json({ error: 'Scraping failed' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// MusicBrainz OAuth callback endpoint
app.get('/api/musicbrainz/callback', (req, res) => {
  console.log(`\n🎵 === MUSICBRAINZ CALLBACK ===`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  console.log(`📝 Query params:`, req.query);
  
  const { code, state, error } = req.query;
  
  if (error) {
    console.log(`❌ OAuth error: ${error}`);
    return res.status(400).json({ error: 'MusicBrainz OAuth error', details: error });
  }
  
  if (code) {
    console.log(`✅ Received authorization code: ${code.substring(0, 10)}...`);
    // TODO: Exchange code for access token
    // For now, just acknowledge receipt
    res.json({ 
      success: true, 
      message: 'MusicBrainz callback received',
      code: code.substring(0, 10) + '...' // Don't log full code
    });
  } else {
    console.log(`❌ No authorization code received`);
    res.status(400).json({ error: 'No authorization code received' });
  }
  
  console.log(`=== END MUSICBRAINZ CALLBACK ===\n`);
});

// Function to resolve actual magnet URL from Prowlarr download URL
async function resolveMagnetUrl(downloadUrl) {
  try {
    console.log(`🔗 Attempting to resolve magnet URL from: ${downloadUrl}`);
    
    // If it's already a magnet URL, return it
    if (downloadUrl.startsWith('magnet:')) {
      console.log(`✅ Already a magnet URL`);
      return downloadUrl;
    }
    
    // If it's a localhost Prowlarr URL, try to get the redirect
    if (downloadUrl.includes('localhost') || downloadUrl.includes('127.0.0.1')) {
      const response = await axios.get(downloadUrl, {
        maxRedirects: 0,
        validateStatus: function (status) {
          return status >= 200 && status < 400; // Accept redirects
        }
      });
      
      // Check if the response is a magnet URL in the Location header
      if (response.headers.location && response.headers.location.startsWith('magnet:')) {
        const magnetUrl = response.headers.location;
        console.log(`✅ Found magnet URL in redirect: ${magnetUrl.substring(0, 60)}...`);
        console.log(`🎯 Magnet hash: ${magnetUrl.match(/btih:([a-zA-Z0-9]+)/)?.[1] || 'unknown'}`);
        return magnetUrl;
      }
      
      // Check if the response body contains a magnet URL
      if (response.data && typeof response.data === 'string') {
        const magnetMatch = response.data.match(/magnet:\?[^"'\s]+/);
        if (magnetMatch) {
          const magnetUrl = magnetMatch[0];
          console.log(`✅ Found magnet URL in response body: ${magnetUrl.substring(0, 60)}...`);
          console.log(`🎯 Magnet hash: ${magnetUrl.match(/btih:([a-zA-Z0-9]+)/)?.[1] || 'unknown'}`);
          return magnetUrl;
        }
      }
      
      console.log(`⚠️ Prowlarr response did not contain a magnet URL`);
      console.log(`📍 Response status: ${response.status}`);
      console.log(`📍 Location header: ${response.headers.location || 'none'}`);
      console.log(`📍 Response type: ${typeof response.data}`);
    }
    
    console.log(`❌ Could not resolve magnet URL from: ${downloadUrl}`);
    return downloadUrl; // Return original URL if we can't resolve it
    
  } catch (error) {
    console.log(`❌ Error resolving magnet URL: ${error.message}`);
    return downloadUrl; // Return original URL on error
  }
}

// === TORRENT STREAMING ENDPOINTS ===

// Get audio stream from torrent
app.post('/api/stream-torrent', async (req, res) => {
  const { magnetLink, fileName, expectedFileCount, async: useAsync = false } = req.body;
  
  console.log(`\n🏴‍☠️ === TORRENT AUDIO STREAM REQUEST ===`);
  console.log(`🧲 Magnet: ${magnetLink?.substring(0, 50)}...`);
  console.log(`📁 File: ${fileName || 'auto-detect'}`);
  console.log(`🎯 Expected file count: ${expectedFileCount || 'any'}`);
  console.log(`⚡ Async: ${useAsync}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!magnetLink) {
    console.log(`❌ No magnet link provided`);
    return res.status(400).json({ error: 'Magnet link is required' });
  }

  try {
    // Resolve the actual magnet URL if it's a Prowlarr download URL
    const resolvedMagnetLink = await resolveMagnetUrl(magnetLink);
    console.log(`🧲 Using magnet link: ${resolvedMagnetLink.substring(0, 50)}...`);
    
    // Validate magnet link format
    if (!resolvedMagnetLink.startsWith('magnet:')) {
      console.log(`❌ Invalid magnet link format: ${resolvedMagnetLink.substring(0, 100)}`);
      return res.status(400).json({ 
        error: 'Invalid magnet link format',
        providedLink: resolvedMagnetLink.substring(0, 100) + '...'
      });
    }
    
    // Check if we already have this torrent ready
    let torrent = activeTorrents.get(resolvedMagnetLink);
    
    if (torrent && torrent.ready) {
      console.log(`♻️ Using existing ready torrent`);
      // Process file selection immediately
      return processStreamRequest(res, torrent, fileName, expectedFileCount, resolvedMagnetLink);
    }
    
    // If async mode requested, return job ID
    if (useAsync) {
      const jobId = generateJobId();
      
      asyncJobs.set(jobId, {
        status: 'pending',
        type: 'stream-torrent',
        params: { magnetLink: resolvedMagnetLink, fileName, expectedFileCount },
        startedAt: new Date().toISOString(),
        progress: 0
      });

      console.log(`🚀 Started async torrent stream preparation with job ID: ${jobId}`);
      
      res.json({
        success: true,
        async: true,
        jobId: jobId,
        message: 'Torrent stream preparation started'
      });

      // Start async processing
      setImmediate(() => processTorrentStreamAsync(jobId, resolvedMagnetLink, fileName, expectedFileCount));
      return;
    }
    
    // Synchronous processing (legacy mode)
    if (!torrent) {
      console.log(`🔄 Adding new torrent to client...`);
      console.log(`📊 WebTorrent client stats: ${torrentClient.torrents.length} active torrents`);
      
      // Add torrent to client
      torrent = await new Promise((resolve, reject) => {
        const addedTorrent = torrentClient.add(resolvedMagnetLink, {
          destroyStoreOnDestroy: true
        });

        const timeout = setTimeout(() => {
          console.log(`⏰ Torrent loading timeout after 45 seconds`);
          console.log(`📊 Torrent stats at timeout: peers=${addedTorrent.peers?.length || 0}, downloaded=${addedTorrent.downloaded || 0}, progress=${((addedTorrent.progress || 0) * 100).toFixed(1)}%`);
          console.log(`🔍 Tracker status: Most trackers failed to connect or timed out`);
          console.log(`💡 This usually means: no active seeders, dead torrent, or network issues`);
          addedTorrent.destroy();
          reject(new Error('No active peers found for this torrent. The torrent may be dead or have no seeders currently online.'));
        }, 45000); // 45 second timeout (increased from 30)

        // More detailed event logging
        addedTorrent.on('metadata', () => {
          console.log(`📋 Torrent metadata received: ${addedTorrent.name}`);
          console.log(`📁 Files: ${addedTorrent.files.length}, Size: ${formatBytes(addedTorrent.length)}`);
        });

        addedTorrent.on('ready', () => {
          clearTimeout(timeout);
          console.log(`✅ Torrent ready: ${addedTorrent.name}`);
          console.log(`📁 Files found: ${addedTorrent.files?.length || 0}`);
          console.log(`👥 Peers connected: ${addedTorrent.peers?.length || 0}`);
          resolve(addedTorrent);
        });

        addedTorrent.on('error', (err) => {
          clearTimeout(timeout);
          console.error(`❌ Torrent error:`, err);
          console.log(`📊 Error occurred with: peers=${addedTorrent.peers?.length || 0}, files=${addedTorrent.files?.length || 0}`);
          reject(err);
        });

        addedTorrent.on('warning', (err) => {
          console.warn(`⚠️ Torrent warning:`, err);
        });

        // Log connection progress
        let lastPeerCount = 0;
        const progressInterval = setInterval(() => {
          const currentPeers = addedTorrent.peers?.length || 0; // Safe access with default
          if (currentPeers !== lastPeerCount) {
            console.log(`👥 Peer count: ${currentPeers} (was ${lastPeerCount})`);
            lastPeerCount = currentPeers;
          }
        }, 5000);

        addedTorrent.on('ready', () => clearInterval(progressInterval));
        addedTorrent.on('error', () => clearInterval(progressInterval));
      });

      // Store the torrent
      activeTorrents.set(resolvedMagnetLink, torrent);
    } else {
      console.log(`♻️ Using existing torrent`);
    }

    // Find audio files
    const audioExtensions = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.wma'];
    const audioFiles = torrent.files.filter(file => {
      return audioExtensions.some(ext => 
        file.name.toLowerCase().endsWith(ext.toLowerCase())
      );
    });

    console.log(`🎵 Found ${audioFiles.length} audio files in torrent`);

    if (audioFiles.length === 0) {
      console.log(`❌ No audio files found in torrent`);
      return res.status(404).json({ error: 'No audio files found in torrent' });
    }

    // Validate file count if expectedFileCount is provided
    if (expectedFileCount && audioFiles.length !== expectedFileCount) {
      console.log(`❌ File count mismatch: expected ${expectedFileCount}, found ${audioFiles.length}`);
      return res.status(400).json({ 
        error: `Torrent file count mismatch: expected ${expectedFileCount} audio files, found ${audioFiles.length}`,
        expectedFileCount,
        actualFileCount: audioFiles.length
      });
    }

    console.log(`✅ File count validation passed: ${audioFiles.length} files${expectedFileCount ? ` (expected ${expectedFileCount})` : ''}`);

    // Find the target file with improved track selection
    let targetFile;
    if (fileName) {
      console.log(`🔍 Looking for specific track: ${fileName}`);
      
      // First try exact name match
      targetFile = audioFiles.find(file => 
        file.name.toLowerCase() === fileName.toLowerCase()
      );
      
      // If no exact match, try partial name matching
      if (!targetFile) {
        targetFile = audioFiles.find(file => 
          file.name.toLowerCase().includes(fileName.toLowerCase()) ||
          fileName.toLowerCase().includes(file.name.toLowerCase())
        );
      }
      
      // If still no match, try track number extraction
      if (!targetFile) {
        // Extract track number from fileName (e.g., "Track 3", "03", "3 - Song Name")
        const trackNumberMatch = fileName.match(/(?:track\s*)?(\d+)/i);
        if (trackNumberMatch) {
          const trackNumber = parseInt(trackNumberMatch[1]);
          console.log(`🔢 Extracted track number: ${trackNumber}`);
          
          // Sort audio files by name to get consistent ordering
          const sortedAudioFiles = [...audioFiles].sort((a, b) => a.name.localeCompare(b.name));
          
          // Try to find by track number (1-indexed)
          if (trackNumber > 0 && trackNumber <= sortedAudioFiles.length) {
            targetFile = sortedAudioFiles[trackNumber - 1];
            console.log(`🎯 Selected track ${trackNumber}: ${targetFile.name}`);
          }
        }
      }
      
      // If still no match, try fuzzy matching on track names
      if (!targetFile) {
        // Remove common prefixes and try matching
        const cleanFileName = fileName.replace(/^\d+[\s\-\.]*/, '').toLowerCase();
        targetFile = audioFiles.find(file => {
          const cleanFile = file.name.replace(/^\d+[\s\-\.]*/, '').toLowerCase();
          return cleanFile.includes(cleanFileName) || cleanFileName.includes(cleanFile);
        });
      }
    }
    
    if (!targetFile) {
      // Sort audio files by name for consistent ordering and use first one
      const sortedAudioFiles = [...audioFiles].sort((a, b) => a.name.localeCompare(b.name));
      targetFile = sortedAudioFiles[0];
      console.log(`🎵 No specific track found, using first file: ${targetFile.name}`);
    } else {
      console.log(`✅ Found target track: ${targetFile.name}`);
    }

    console.log(`🎵 Selected file: ${targetFile.name} (${(targetFile.length / 1024 / 1024).toFixed(2)} MB)`);

    // Prepare track listing for frontend
    const trackListing = audioFiles
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file, index) => ({
        index: index + 1,
        name: file.name,
        size: file.length,
        selected: file === targetFile
      }));

    console.log(`📋 Track listing prepared: ${trackListing.length} tracks`);

    // Return stream info with track listing
    res.json({
      success: true,
      torrentName: torrent.name,
      fileName: targetFile.name,
      fileSize: targetFile.length,
      streamUrl: `/api/stream-file/${encodeURIComponent(resolvedMagnetLink)}/${encodeURIComponent(targetFile.name)}`,
      mimeType: getMimeType(targetFile.name),
      trackListing: trackListing,
      totalTracks: audioFiles.length
    });

  } catch (error) {
    console.error(`❌ Error processing torrent:`, error);
    res.status(500).json({ error: error.message });
  }
  
  console.log(`=== END TORRENT STREAM REQUEST ===\n`);
});

// Helper function to process stream request (sync)
function processStreamRequest(res, torrent, fileName, expectedFileCount, resolvedMagnetLink) {
  try {
    // Find audio files
    const audioExtensions = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.wma'];
    const audioFiles = torrent.files.filter(file => {
      return audioExtensions.some(ext => 
        file.name.toLowerCase().endsWith(ext.toLowerCase())
      );
    });

    console.log(`🎵 Found ${audioFiles.length} audio files in torrent`);

    if (audioFiles.length === 0) {
      console.log(`❌ No audio files found in torrent`);
      return res.status(404).json({ error: 'No audio files found in torrent' });
    }

    // Validate file count if expectedFileCount is provided
    if (expectedFileCount && audioFiles.length !== expectedFileCount) {
      console.log(`❌ File count mismatch: expected ${expectedFileCount}, found ${audioFiles.length}`);
      return res.status(400).json({ 
        error: `Torrent file count mismatch: expected ${expectedFileCount} audio files, found ${audioFiles.length}`,
        expectedFileCount,
        actualFileCount: audioFiles.length
      });
    }

    // Find the target file with enhanced track selection
    let targetFile;
    if (fileName) {
      console.log(`🔍 Looking for specific track: ${fileName}`);
      
      // Enhanced track selection logic (same as before)
      targetFile = audioFiles.find(file => 
        file.name.toLowerCase() === fileName.toLowerCase()
      );
      
      if (!targetFile) {
        targetFile = audioFiles.find(file => 
          file.name.toLowerCase().includes(fileName.toLowerCase()) ||
          fileName.toLowerCase().includes(file.name.toLowerCase())
        );
      }
      
      if (!targetFile) {
        const trackNumberMatch = fileName.match(/(?:track\s*)?(\d+)/i);
        if (trackNumberMatch) {
          const trackNumber = parseInt(trackNumberMatch[1]);
          const sortedAudioFiles = [...audioFiles].sort((a, b) => a.name.localeCompare(b.name));
          
          if (trackNumber > 0 && trackNumber <= sortedAudioFiles.length) {
            targetFile = sortedAudioFiles[trackNumber - 1];
          }
        }
      }
    }
    
    if (!targetFile) {
      const sortedAudioFiles = [...audioFiles].sort((a, b) => a.name.localeCompare(b.name));
      targetFile = sortedAudioFiles[0];
    }

    console.log(`🎵 Selected file: ${targetFile.name} (${(targetFile.length / 1024 / 1024).toFixed(2)} MB)`);

    // Prepare track listing
    const trackListing = audioFiles
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file, index) => ({
        index: index + 1,
        name: file.name,
        size: file.length,
        selected: file === targetFile
      }));

    // Return stream info with track listing
    return res.json({
      success: true,
      torrentName: torrent.name,
      fileName: targetFile.name,
      fileSize: targetFile.length,
      streamUrl: `/api/stream-file/${encodeURIComponent(resolvedMagnetLink)}/${encodeURIComponent(targetFile.name)}`,
      mimeType: getMimeType(targetFile.name),
      trackListing: trackListing,
      totalTracks: audioFiles.length
    });

  } catch (error) {
    console.error(`❌ Error processing stream request:`, error);
    return res.status(500).json({ error: error.message });
  }
}

// Async torrent stream processing function
async function processTorrentStreamAsync(jobId, resolvedMagnetLink, fileName, expectedFileCount) {
  try {
    console.log(`\n🚀 === ASYNC TORRENT STREAM (${jobId}) ===`);
    
    // Update job status
    asyncJobs.set(jobId, {
      ...asyncJobs.get(jobId),
      status: 'processing',
      progress: 10
    });

    // Check if we already have this torrent
    let torrent = activeTorrents.get(resolvedMagnetLink);
    
    if (!torrent) {
      console.log(`🔄 Adding new torrent to client...`);
      
      // Update progress
      asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 20 });
      
      // Add torrent to client
      torrent = await new Promise((resolve, reject) => {
        const addedTorrent = torrentClient.add(resolvedMagnetLink, {
          destroyStoreOnDestroy: true
        });

        const timeout = setTimeout(() => {
          console.log(`⏰ Torrent loading timeout after 45 seconds`);
          addedTorrent.destroy();
          reject(new Error('No active peers found for this torrent'));
        }, 45000);

        addedTorrent.on('ready', () => {
          clearTimeout(timeout);
          console.log(`✅ Torrent ready: ${addedTorrent.name}`);
          resolve(addedTorrent);
        });

        addedTorrent.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Store the torrent
      activeTorrents.set(resolvedMagnetLink, torrent);
    }

    // Update progress
    asyncJobs.set(jobId, { ...asyncJobs.get(jobId), progress: 80 });

    // Process file selection
    const result = await processStreamRequestAsync(torrent, fileName, expectedFileCount, resolvedMagnetLink);

    // Complete the job
    asyncJobs.set(jobId, {
      ...asyncJobs.get(jobId),
      status: 'completed',
      progress: 100,
      completedAt: new Date().toISOString(),
      result: result
    });

    console.log(`✅ Async torrent stream completed for job ${jobId}`);

  } catch (error) {
    console.error(`❌ Error in async torrent stream (${jobId}):`, error);
    asyncJobs.set(jobId, {
      ...asyncJobs.get(jobId),
      status: 'failed',
      progress: 100,
      error: error.message,
      completedAt: new Date().toISOString()
    });
  }
}

// Helper function to process stream request async
async function processStreamRequestAsync(torrent, fileName, expectedFileCount, resolvedMagnetLink) {
  // Same logic as processStreamRequest but returns data instead of sending response
  const audioExtensions = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.wma'];
  const audioFiles = torrent.files.filter(file => {
    return audioExtensions.some(ext => 
      file.name.toLowerCase().endsWith(ext.toLowerCase())
    );
  });

  if (audioFiles.length === 0) {
    throw new Error('No audio files found in torrent');
  }

  if (expectedFileCount && audioFiles.length !== expectedFileCount) {
    throw new Error(`File count mismatch: expected ${expectedFileCount}, found ${audioFiles.length}`);
  }

  // Find target file (same logic as sync version)
  let targetFile;
  if (fileName) {
    targetFile = audioFiles.find(file => 
      file.name.toLowerCase() === fileName.toLowerCase()
    );
    
    if (!targetFile) {
      targetFile = audioFiles.find(file => 
        file.name.toLowerCase().includes(fileName.toLowerCase()) ||
        fileName.toLowerCase().includes(file.name.toLowerCase())
      );
    }
  }
  
  if (!targetFile) {
    const sortedAudioFiles = [...audioFiles].sort((a, b) => a.name.localeCompare(b.name));
    targetFile = sortedAudioFiles[0];
  }

  const trackListing = audioFiles
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file, index) => ({
      index: index + 1,
      name: file.name,
      size: file.length,
      selected: file === targetFile
    }));

  return {
    success: true,
    torrentName: torrent.name,
    fileName: targetFile.name,
    fileSize: targetFile.length,
    streamUrl: `/api/stream-file/${encodeURIComponent(resolvedMagnetLink)}/${encodeURIComponent(targetFile.name)}`,
    mimeType: getMimeType(targetFile.name),
    trackListing: trackListing,
    totalTracks: audioFiles.length
  };
}

// Get track listing from torrent without starting playback
app.post('/api/torrent-tracks', async (req, res) => {
  const { magnetLink } = req.body;
  
  console.log(`\n📋 === TORRENT TRACK LISTING ===`);
  console.log(`🧲 Magnet: ${magnetLink?.substring(0, 50)}...`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!magnetLink) {
    console.log(`❌ No magnet link provided`);
    return res.status(400).json({ error: 'Magnet link is required' });
  }

  try {
    // Resolve the actual magnet URL if it's a Prowlarr download URL
    const resolvedMagnetLink = await resolveMagnetUrl(magnetLink);
    console.log(`🧲 Using magnet link: ${resolvedMagnetLink.substring(0, 50)}...`);
    
    // Check if we already have this torrent
    let torrent = activeTorrents.get(resolvedMagnetLink);
    
    if (!torrent) {
      console.log(`🔄 Need to add torrent to get track listing...`);
      // Add torrent to client with shorter timeout for track listing
      torrent = await new Promise((resolve, reject) => {
        const addedTorrent = torrentClient.add(resolvedMagnetLink, {
          destroyStoreOnDestroy: true
        });

        const timeout = setTimeout(() => {
          console.log(`⏰ Track listing timeout after 30 seconds`);
          addedTorrent.destroy();
          reject(new Error('Timeout getting track listing - torrent may be dead'));
        }, 30000);

        addedTorrent.on('ready', () => {
          clearTimeout(timeout);
          console.log(`✅ Torrent ready for track listing: ${addedTorrent.name}`);
          resolve(addedTorrent);
        });

        addedTorrent.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Store the torrent
      activeTorrents.set(resolvedMagnetLink, torrent);
    } else {
      console.log(`♻️ Using existing torrent for track listing`);
    }

    // Find audio files
    const audioExtensions = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.wma'];
    const audioFiles = torrent.files.filter(file => {
      return audioExtensions.some(ext => 
        file.name.toLowerCase().endsWith(ext.toLowerCase())
      );
    });

    console.log(`🎵 Found ${audioFiles.length} audio files in torrent`);

    if (audioFiles.length === 0) {
      console.log(`❌ No audio files found in torrent`);
      return res.status(404).json({ error: 'No audio files found in torrent' });
    }

    // Prepare track listing
    const trackListing = audioFiles
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file, index) => ({
        index: index + 1,
        name: file.name,
        size: file.length,
        duration: null // Could be extracted with metadata if needed
      }));

    console.log(`📋 Track listing prepared: ${trackListing.length} tracks`);

    // Return track listing
    res.json({
      success: true,
      torrentName: torrent.name,
      trackListing: trackListing,
      totalTracks: audioFiles.length
    });

  } catch (error) {
    console.error(`❌ Error getting track listing:`, error);
    res.status(500).json({ error: error.message });
  }
  
  console.log(`=== END TORRENT TRACK LISTING ===\n`);
});

// Stream audio file from torrent
app.get('/api/stream-file/:magnetLink/:fileName', async (req, res) => {
  const { magnetLink, fileName } = req.params;
  const decodedMagnetLink = decodeURIComponent(magnetLink);
  const decodedFileName = decodeURIComponent(fileName);
  
  console.log(`\n🎵 === STREAMING AUDIO FILE ===`);
  console.log(`🧲 Magnet: ${decodedMagnetLink.substring(0, 50)}...`);
  console.log(`📁 File: ${decodedFileName}`);
  
  try {
    const torrent = activeTorrents.get(decodedMagnetLink);
    
    if (!torrent) {
      console.log(`❌ Torrent not found in active torrents`);
      return res.status(404).json({ error: 'Torrent not found' });
    }

    const targetFile = torrent.files.find(file => file.name === decodedFileName);
    
    if (!targetFile) {
      console.log(`❌ File not found in torrent`);
      return res.status(404).json({ error: 'File not found in torrent' });
    }

    // Set headers for audio streaming
    const mimeType = getMimeType(decodedFileName);
    res.set({
      'Content-Type': mimeType,
      'Content-Length': targetFile.length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });

    // Handle range requests for audio seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : targetFile.length - 1;
      const chunksize = (end - start) + 1;
      
      res.status(206);
      res.set({
        'Content-Range': `bytes ${start}-${end}/${targetFile.length}`,
        'Content-Length': chunksize
      });
      
      console.log(`🎵 Streaming range: ${start}-${end}/${targetFile.length}`);
      const stream = targetFile.createReadStream({ start, end });
      stream.pipe(res);
    } else {
      console.log(`🎵 Streaming full file`);
      const stream = targetFile.createReadStream();
      stream.pipe(res);
    }

  } catch (error) {
    console.error(`❌ Error streaming file:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up old torrents endpoint
app.post('/api/cleanup-torrents', (req, res) => {
  console.log(`\n🧹 === CLEANING UP TORRENTS ===`);
  
  const before = activeTorrents.size;
  
  // Remove torrents that haven't been accessed recently
  for (const [magnetLink, torrent] of activeTorrents.entries()) {
    try {
      torrent.destroy();
      activeTorrents.delete(magnetLink);
    } catch (error) {
      console.error(`❌ Error destroying torrent:`, error);
    }
  }
  
  console.log(`🧹 Cleaned up ${before} torrents`);
  res.json({ message: `Cleaned up ${before} torrents` });
});

// New endpoint: Play specific track from album
app.post('/api/play-album-track', async (req, res) => {
  const { albumMagnetLink, trackName, trackIndex, trackTitle, artistName } = req.body;
  
  console.log(`\n🎵 === PLAY ALBUM TRACK ===`);
  console.log(`💿 Album Magnet: ${albumMagnetLink?.substring(0, 50)}...`);
  console.log(`🎤 Track Name: ${trackName}`);
  console.log(`📊 Track Index: ${trackIndex}`);
  console.log(`🎵 Track Title: ${trackTitle}`);
  console.log(`👤 Artist: ${artistName}`);
  console.log(`🕐 Timestamp: ${new Date().toISOString()}`);
  
  if (!albumMagnetLink) {
    console.log(`❌ Missing required parameter: albumMagnetLink`);
    return res.status(400).json({ error: 'albumMagnetLink is required' });
  }

  try {
    // Resolve the actual magnet URL if it's a Prowlarr download URL
    const resolvedMagnetLink = await resolveMagnetUrl(albumMagnetLink);
    console.log(`🧲 Using resolved magnet link: ${resolvedMagnetLink.substring(0, 50)}...`);
    
    // Check if we already have this torrent
    let torrent = activeTorrents.get(resolvedMagnetLink);
    
    if (!torrent) {
      console.log(`🔄 Adding album torrent to get track listing...`);
      // Add torrent to client
      torrent = await new Promise((resolve, reject) => {
        const addedTorrent = torrentClient.add(resolvedMagnetLink, {
          destroyStoreOnDestroy: true
        });

        const timeout = setTimeout(() => {
          console.log(`⏰ Album torrent timeout after 45 seconds`);
          addedTorrent.destroy();
          reject(new Error('Timeout loading album torrent - torrent may be dead'));
        }, 45000);

        addedTorrent.on('ready', () => {
          clearTimeout(timeout);
          console.log(`✅ Album torrent ready: ${addedTorrent.name}`);
          resolve(addedTorrent);
        });

        addedTorrent.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Store the torrent
      activeTorrents.set(resolvedMagnetLink, torrent);
    } else {
      console.log(`♻️ Using existing album torrent`);
    }

    // Find audio files in the album
    const audioExtensions = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.wma'];
    const audioFiles = torrent.files.filter(file => {
      return audioExtensions.some(ext => 
        file.name.toLowerCase().endsWith(ext.toLowerCase())
      );
    });

    console.log(`🎵 Found ${audioFiles.length} audio files in album`);

    if (audioFiles.length === 0) {
      console.log(`❌ No audio files found in album`);
      return res.status(404).json({ error: 'No audio files found in album' });
    }

    // Sort files by name for consistent ordering
    audioFiles.sort((a, b) => a.name.localeCompare(b.name));

    let targetFile = null;

    // Strategy 1: Find by exact track name match
    if (trackName) {
      targetFile = audioFiles.find(file => file.name === trackName);
      if (targetFile) {
        console.log(`✅ Found track by exact name match: ${targetFile.name}`);
      }
    }

    // Strategy 2: Find by track index
    if (!targetFile && trackIndex !== undefined && trackIndex >= 1 && trackIndex <= audioFiles.length) {
      targetFile = audioFiles[trackIndex - 1]; // Convert to 0-based index
      console.log(`✅ Found track by index ${trackIndex}: ${targetFile.name}`);
    }

    // Strategy 3: Find by fuzzy matching track title and artist
    if (!targetFile && trackTitle) {
      const searchTerm = trackTitle.toLowerCase();
      
      // First try exact title match
      targetFile = audioFiles.find(file => {
        const fileName = file.name.toLowerCase();
        return fileName.includes(searchTerm);
      });

      if (!targetFile && artistName) {
        // Try matching both artist and track title
        const artistTerm = artistName.toLowerCase();
        targetFile = audioFiles.find(file => {
          const fileName = file.name.toLowerCase();
          return fileName.includes(searchTerm) && fileName.includes(artistTerm);
        });
      }

      if (!targetFile) {
        // Try more flexible matching (remove common words, punctuation)
        const cleanSearchTerm = searchTerm.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        targetFile = audioFiles.find(file => {
          const cleanFileName = file.name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
          return cleanFileName.includes(cleanSearchTerm);
        });
      }

      if (targetFile) {
        console.log(`✅ Found track by title matching: ${targetFile.name}`);
      }
    }

    // Strategy 4: Default to first track if nothing else worked
    if (!targetFile) {
      targetFile = audioFiles[0];
      console.log(`⚠️ No specific track match found, defaulting to first track: ${targetFile.name}`);
    }

    if (!targetFile) {
      console.log(`❌ Could not determine target track`);
      return res.status(404).json({ error: 'Could not find specified track in album' });
    }

    // Generate stream URL for the specific track
    const encodedMagnetLink = encodeURIComponent(resolvedMagnetLink);
    const encodedFileName = encodeURIComponent(targetFile.name);
    const streamUrl = `/api/stream-file/${encodedMagnetLink}/${encodedFileName}`;

    console.log(`✅ Generated stream URL for track: ${targetFile.name}`);
    console.log(`📁 File size: ${formatBytes(targetFile.length)}`);

    // Return track information with stream URL
    res.json({
      success: true,
      streamUrl: streamUrl,
      fileName: targetFile.name,
      fileSize: targetFile.length,
      albumName: torrent.name,
      trackIndex: audioFiles.indexOf(targetFile) + 1,
      totalTracks: audioFiles.length,
      albumTracks: audioFiles.map((file, index) => ({
        index: index + 1,
        name: file.name,
        size: file.length
      }))
    });

  } catch (error) {
    console.error(`❌ Error setting up album track playback:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to get MIME type
function getMimeType(filename) {
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 ================================`);
  console.log(`   LIZZEN.ORG BACKEND STARTED`);
  console.log(`🚀 ================================`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`🌍 Domain: ${MUSICBRAINZ_CONFIG.domain}`);
  console.log(`📡 Prowlarr API: ${PROWLARR_CONFIG.baseUrl}`);
  console.log(`🎵 MusicBrainz: ${MUSICBRAINZ_CONFIG.baseUrl}`);
  console.log(`🔗 Callback: ${MUSICBRAINZ_CONFIG.callbackUri}`);
  console.log(`🔑 API Key: ${PROWLARR_CONFIG.apiKey.substring(0, 8)}...`);
  console.log(`🕐 Started at: ${new Date().toISOString()}`);
  console.log(`🚀 ================================\n`);
});
