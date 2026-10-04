// 界面文案统一走 i18n；缺键时退回内置中文模板，界面不会出现空串或裸 key。
// All UI copy goes through i18n and falls back to the built-in Chinese template, so the
// UI never shows an empty string or a raw key.
// 本模块界面文案统一走 i18n，词典是唯一文案来源。
// UI copy in this module goes through i18n; the dictionary is the single source of copy.
// 两种形态：
//   xxxText('key')            —— 推荐。词典缺键时返回键名本身，漏译一眼可见。
//   xxxText('key', '兜底')     —— 仅在「缺键时该显示什么」有明确要求时用。
//   xxxText('key', '含 {p} 的模板', {p: v}) —— 带插值。params 同时喂给 t() 与兜底模板。
// 缺键刻意返回键名而不是空串：空串会让漏译静默发生，键名在界面上是一眼能认出的错误。
// Two call shapes. A missing key returns the key itself on purpose: an empty string would
// make an untranslated string fail silently, while a bare key is self-identifying on screen.
// params 同时透传给 t() 并插值进兜底模板，缺词典时占位符仍会被替换掉。
// params goes to both t() and the fallback template so placeholders still resolve.
function homeDiscoverText(key, fallback, params) {
  var i18n = (typeof window !== 'undefined' && window.MineradioI18n) || null;
  var text = i18n && typeof i18n.t === 'function' ? i18n.t(key, params) : '';
  if (text && text !== key) {
    if (params && typeof params === "object") {
      Object.keys(params).forEach(function (field) {
        text = text.split('{' + field + '}').join(String(params[field]));
      });
    }
    return text;
  }
  if (fallback == null) return key;
  var out = String(fallback);
  if (params && typeof params === "object") {
    Object.keys(params).forEach(function (field) {
      out = out.split('{' + field + '}').join(String(params[field]));
    });
  }
  return out;
}
function fallbackHomeTiles() {
  return [
    { kind: 'login', title: '登录同步歌单', sub: homeDiscoverText('discover_platforms') },
    { kind: 'search', title: homeDiscoverText('discover_search_song'), sub: homeDiscoverText('discover_original_first'), query: '' },
    { kind: 'local', title: homeDiscoverText('discover_import_local'), sub: homeDiscoverText('discover_local_visualize') },
    { kind: 'podcastSearch', title: homeDiscoverText('discover_search_podcasts'), sub: homeDiscoverText('discover_longform_radio') },
    { kind: 'guide', title: homeDiscoverText('discover_visual_stage'), sub: homeDiscoverText('discover_particles_lyrics_cover') },
  ];
}
function homeTileCover(item) {
  if (!item) return '';
  if (item.kind === 'song') return songCoverSrc(item.song, 220);
  return item.cover ? coverUrlWithSize(item.cover, 220) : '';
}
function homeToneForItem(item, index) {
  if (!item) return 'daily';
  if (item.kind === 'recent') return 'search';
  if (item.kind === 'profile') return 'local';
  if (item.tone) return item.tone;
  if (item.kind === 'song') return index % 2 ? 'search' : 'daily';
  if (item.kind === 'playlist') return 'playlist';
  if (item.kind === 'podcast' || item.kind === 'podcastSearch') return 'podcast';
  if (item.kind === 'local') return 'local';
  if (item.kind === 'guide') return 'guide';
  if (item.kind === 'login') return 'library';
  if (item.kind === 'search') return 'search';
  return ['daily', 'playlist', 'local', 'guide', 'search'][index % 5];
}
function renderHomeMosaic(items) {
  var cells = document.querySelectorAll('#home-mosaic .home-mosaic-cell');
  if (!cells.length) return;
  var covers = [];
  (items || []).forEach(function (item) {
    var cover = homeTileCover(item);
    if (cover) covers.push(cover);
  });
  for (var i = 0; i < cells.length; i++) {
    var src = covers[i] || covers[(i + 1) % Math.max(1, covers.length)] || '';
    cells[i].style.backgroundImage = src ? 'url("' + cssImageUrl(src) + '")' : '';
    cells[i].classList.toggle('has-cover', !!src);
    cells[i].classList.toggle('home-skeleton', !src && homeDiscoverState.loading);
  }
}
function renderHomeTiles() {
  var row = document.getElementById('home-tile-row');
  var title = document.getElementById('home-rail-title');
  var note = document.getElementById('home-rail-note');
  if (!row) return;
  var tiles = [];
  var loggedOutHome = !homeDiscoverState.loggedIn && !hasAnyPlatformLogin();
  var summary = homeListenSummary();
  if (summary.recent && tiles.length < 5) {
    tiles.push({ kind: 'recent', title: summary.recent.name || homeDiscoverText('home_continue', '继续播放'), sub: summary.recent.artist || summary.recent.source || '', cover: summary.recent.cover, record: summary.recent });
  }
  if (summary.topArtist && tiles.length < 5) {
    tiles.push({ kind: 'profile', title: summary.topArtist.name, sub: homeDiscoverText('home_frequent_artists', '常听歌手') + ' · ' + homeDiscoverText('home_artist_plays', '{count} 次', { count: summary.topArtist.plays }), query: summary.topArtist.name });
  }
  if (!loggedOutHome) {
    homeDiscoverState.songs.slice(0, Math.max(0, 4 - tiles.length)).forEach(function (song, i) {
      tiles.push({ kind: 'song', index: i, song: song, title: song.name || homeDiscoverText('dash_today_songs'), sub: song.artist || songSourceLabel(song) });
    });
    homeDiscoverState.playlists.slice(0, Math.max(0, 5 - tiles.length)).forEach(function (pl, i) {
      tiles.push({ kind: 'playlist', index: i, title: pl.name || homeDiscoverText('dash_recommend_playlist'), sub: (pl.trackCount ? pl.trackCount + ' ' + homeDiscoverText('track_count', '首') : 'Playlist') + (pl.playCount ? ' · ' + compactHomeCount(pl.playCount) + homeDiscoverText('dash_play_count_suffix') : ''), cover: pl.cover });
    });
    if (tiles.length < 5) {
      homeDiscoverState.podcasts.slice(0, 5 - tiles.length).forEach(function (p, i) {
        tiles.push({ kind: 'podcast', index: i, title: p.name || homeDiscoverText('discover_hot_podcasts'), sub: p.djName || p.category || 'Podcast', cover: p.cover });
      });
    }
  }
  if (!tiles.length) tiles = fallbackHomeTiles();
  tiles = tiles.slice(0, 5);
  if (title) title.textContent = summary.recent ? homeDiscoverText('discover_continue') : (loggedOutHome ? homeDiscoverText('discover_start_here') : homeDiscoverText('discover_playlists_recommend'));
  if (note) {
    var liveNote = homeDiscoverState.updatedAt ? homeDiscoverText('discover_just_updated') : homeDiscoverText('discover_click_to_play');
    note.textContent = homeDiscoverState.loading
      ? homeDiscoverText('home_recommended', '正在整理推荐')
      : (loggedOutHome
        ? homeDiscoverText('login_show_playlists', '登录平台后显示个人推荐')
        : (homeDiscoverState.error ? homeDiscoverText('discover_offline_picks') : liveNote));
  }
  row.innerHTML = tiles.map(function (item, i) {
    var cover = homeTileCover(item);
    var tone = homeToneForItem(item, i);
    var coverClass = 'home-tile-cover' + (cover ? ' has-cover' : '');
    return '<button class="home-tile' + (!cover && homeDiscoverState.loading ? ' home-skeleton' : '') + '" data-home-tone="' + escHtml(tone) + '" type="button" onclick="handleHomeTileClick(' + i + ')">' +
      '<div class="' + coverClass + '" style="' + (cover ? 'background-image:url(&quot;' + escHtml(cssImageUrl(cover)) + '&quot;)' : '') + '"></div>' +
      '<div class="home-tile-title">' + escHtml(item.title || '') + '</div>' +
      '<div class="home-tile-sub">' + escHtml(item.sub || '') + '</div>' +
      '</button>';
  }).join('');
  row._homeTiles = tiles;
  renderHomeMosaic(tiles);
}
function renderHomeDiscover() {
  var sub = document.getElementById('home-subtitle');
  var loggedOutHome = !homeDiscoverState.loggedIn && !hasAnyPlatformLogin();
  var weatherTitle = document.getElementById('home-weather-title');
  var weatherKicker = document.getElementById('home-weather-kicker');
  var weatherMeta = document.getElementById('home-weather-meta');
  if (weatherTitle) weatherTitle.textContent = homeDiscoverText('discover_my_library');
  if (weatherKicker) weatherKicker.textContent = 'Mineradio · Your Library';
  if (sub) {
    if (loggedOutHome) sub.textContent = homeDiscoverText('home_loggedout_hint', '登录后会把你的歌单、常听歌手和最近播放放在这里；也可以直接搜索或导入本地音乐。');
    else sub.textContent = homeDiscoverText('discover_start_hint');
  }
  if (weatherMeta) {
    var meta = loggedOutHome ? [homeDiscoverText('discover_cross_platform'), homeDiscoverText('discover_local_music'), homeDiscoverText('discover_hot_radio')] : [homeDiscoverText('discover_personal_recommend'), homeDiscoverText('discover_platform_playlists'), homeDiscoverText('discover_hot_radio')];
    weatherMeta.innerHTML = meta.map(function (text) { return '<span class="home-weather-pill">' + escHtml(text) + '</span>'; }).join('');
  }
  var daily = homeDiscoverState.songs[0] || null;
  var cardSongB = homeDiscoverState.songs[1] || null;
  var cardSongC = homeDiscoverState.songs[2] || null;
  var playlistItem = homeDiscoverState.playlists[0] || null;
  var podcastItem = homeDiscoverState.podcasts[0] || null;
  var summary = homeListenSummary();
  var weatherCardTitle = document.getElementById('home-weather-card-title');
  var weatherCardSub = document.getElementById('home-weather-card-sub');
  var dailyTitle = document.getElementById('home-daily-title');
  var dailySub = document.getElementById('home-daily-sub');
  var privateTitle = document.getElementById('home-private-title');
  var privateSub = document.getElementById('home-private-sub');
  var continueTitle = document.getElementById('home-continue-title');
  var continueSub = document.getElementById('home-continue-sub');
  var profileTitle = document.getElementById('home-profile-title');
  var profileSub = document.getElementById('home-profile-sub');
  var libTitle = document.getElementById('home-library-title');
  var libSub = document.getElementById('home-library-sub');
  if (weatherCardTitle) weatherCardTitle.textContent = homeDiscoverText('home_my_playlists', '我的歌单');
  if (weatherCardSub) {
    weatherCardSub.textContent = playlistItem ? (((playlistItem.trackCount || 0) ? playlistItem.trackCount + ' ' + homeDiscoverText('track_count', '首') + ' · ' : '') + (playlistItem.creator || homeDiscoverText('home_my_playlists_sub', '打开左侧歌单库'))) : homeDiscoverText('home_my_playlists_sub', '打开左侧歌单库');
  }
  if (continueTitle) continueTitle.textContent = summary.recent ? summary.recent.name : homeDiscoverText('home_continue', '继续播放');
  if (continueSub) continueSub.textContent = summary.recent ? (summary.recent.artist || summary.recent.source || homeDiscoverText('dash_recent_plays')) : homeDiscoverText('home_continue_sub', '从当前队列或最近播放继续');
  if (profileTitle) profileTitle.textContent = summary.topArtist ? summary.topArtist.name : (summary.topSong ? summary.topSong.name : homeDiscoverText('home_profile', '听歌画像'));
  if (profileSub) profileSub.textContent = summary.topArtist ? (homeDiscoverText('home_frequent_artists', '常听歌手') + ' · ' + homeDiscoverText('home_artist_plays', '{count} 次', { count: summary.topArtist.plays })) : (summary.totalPlays ? summary.totalPlays + homeDiscoverText('discover_valid_plays_suffix') : homeDiscoverText('home_profile_sub', '播放几首后生成偏好'));
  if (loggedOutHome) {
    if (dailyTitle) dailyTitle.textContent = homeDiscoverText('home_daily', '每日推荐');
    if (dailySub) dailySub.textContent = homeDiscoverText('home_daily_sub', '使用当前 Mineradio 推荐数据');
    if (privateTitle) privateTitle.textContent = homeDiscoverText('discover_recommended_songs');
    if (privateSub) privateSub.textContent = homeDiscoverText('discover_login_sync_more');
    if (libTitle) libTitle.textContent = homeDiscoverText('discover_more_songs');
    if (libSub) libSub.textContent = homeDiscoverText('discover_continue_after_play');
    setHomeArt('home-weather-art', '', 280);
    setHomeArt('home-daily-art', '', 280);
    setHomeArt('home-private-art', '', 280);
    setHomeArt('home-continue-art', summary.recent && summary.recent.cover, 280);
    setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover, 280);
    setHomeArt('home-library-art', '', 280);
  } else {
    if (dailyTitle) dailyTitle.textContent = daily ? daily.name : homeDiscoverText('home_daily', '每日推荐');
    if (dailySub) dailySub.textContent = daily ? ((daily.artist || songSourceLabel(daily) || homeDiscoverText('dash_today_songs')) + homeDiscoverText('discover_play_today_queue')) : homeDiscoverText('discover_sync_today');
    if (privateTitle) privateTitle.textContent = cardSongB ? cardSongB.name : homeDiscoverText('home_private_radio', '私人电台');
    if (privateSub) privateSub.textContent = cardSongB ? (cardSongB.artist || songSourceLabel(cardSongB) || homeDiscoverText('discover_recommended_songs')) : (homeDiscoverState.songs.length + homeDiscoverText('discover_tracks_pref_suffix'));
    if (libTitle) libTitle.textContent = cardSongC ? cardSongC.name : (summary.topArtist ? summary.topArtist.name : homeDiscoverText('discover_more_songs'));
    if (libSub) libSub.textContent = cardSongC ? (cardSongC.artist || songSourceLabel(cardSongC) || homeDiscoverText('discover_recommended_songs')) : (summary.topArtist ? (homeDiscoverText('discover_artist_pref_prefix') + summary.topArtist.plays + homeDiscoverText('discover_times_suffix')) : homeDiscoverText('discover_generate_prefs'));
    setHomeArt('home-weather-art', (userPlaylists[0] && userPlaylists[0].cover) || (playlistItem && playlistItem.cover) || daily && daily.cover, 280);
    setHomeArt('home-daily-art', daily && daily.cover, 280);
    setHomeArt('home-private-art', cardSongB && cardSongB.cover || daily && daily.cover || summary.recent && summary.recent.cover || playlistItem && playlistItem.cover, 280);
    setHomeArt('home-continue-art', summary.recent && summary.recent.cover || playlistItem && playlistItem.cover, 280);
    setHomeArt('home-profile-art', summary.topSong && summary.topSong.cover || podcastItem && podcastItem.cover, 280);
    setHomeArt('home-library-art', cardSongC && cardSongC.cover || summary.topSong && summary.topSong.cover || summary.recent && summary.recent.cover || podcastItem && podcastItem.cover, 280);
  }
  renderHomeTiles();
}
async function loadHomeDiscover(force) {
  if (homeDiscoverState.loading) return;
  if (homeDiscoverState.loaded && !force) return;
  var token = ++homeDiscoverToken;
  homeDiscoverState.loading = true;
  homeDiscoverState.error = '';
  renderHomeDiscover();
  try {
    var data = await apiJson('/api/discover/home?t=' + Date.now());
    if (token !== homeDiscoverToken) return;
    homeDiscoverState.loggedIn = !!(data && data.loggedIn) || hasAnyPlatformLogin();
    homeDiscoverState.mode = data && data.mode || (homeDiscoverState.loggedIn ? 'member' : 'starter');
    homeDiscoverState.songs = homeDiscoverState.loggedIn ? (data && data.dailySongs || []).map(cloneSong) : [];
    homeDiscoverState.playlists = homeDiscoverState.loggedIn ? ((data && data.playlists && data.playlists.length) ? data.playlists : userPlaylists.slice(0, 10)) : [];
    homeDiscoverState.podcasts = homeDiscoverState.loggedIn ? (data && data.podcasts || []) : [];
    homeDiscoverState.updatedAt = Number(data && data.updatedAt) || Date.now();
    homeDiscoverState.loaded = true;
  } catch (e) {
    console.warn('home discover failed:', e);
    if (token === homeDiscoverToken) homeDiscoverState.error = 'DISCOVER_FAILED';
  } finally {
    if (token === homeDiscoverToken) {
      homeDiscoverState.loading = false;
      renderHomeDiscover();
    }
  }
}
