// Aviation Safety Check
// Client-side search over letter-sharded indexes + MD5-keyed detail shards

(function() {
    'use strict';

    const BASE = '';
    let stats = null;
    let indexCache = {};   // 'op_a' -> entries array
    let detailCache = {};  // 'op/a3' -> records
    let proxCache = {};    // state -> entries
    let searchTimeout = null;
    let currentMode = 'operator';

    function fmtInt(n) {
        return n.toLocaleString('en-US');
    }

    function fmtDate(d) {
        if (!d) return '';
        // Parse "MM/DD/YY HH:MM:SS" or similar
        var m = d.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
        if (m) {
            var yr = m[3].length === 2 ? (parseInt(m[3]) > 50 ? '19' + m[3] : '20' + m[3]) : m[3];
            return m[1] + '/' + m[2] + '/' + yr;
        }
        return d.substring(0, 10);
    }

    function sevLabel(sev) {
        switch (sev) {
            case 'FATL': return { text: 'Fatal', cls: 'sev-fatal' };
            case 'SERS': return { text: 'Serious', cls: 'sev-serious' };
            case 'MINR': return { text: 'Minor', cls: 'sev-minor' };
            case 'NONE': return { text: 'None', cls: 'sev-none' };
            default: return { text: sev || 'Unknown', cls: 'sev-none' };
        }
    }

    function md5Shard(key) {
        // Simple hash for shard lookup — must match pipeline's md5_shard
        // We'll use the key directly to look up detail shards
        return key;
    }

    function esc(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // Haversine distance in miles
    function haversine(lat1, lon1, lat2, lon2) {
        var R = 3959; // Earth radius in miles
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    async function init() {
        try {
            var resp = await fetch(BASE + 'data/stats.json');
            stats = await resp.json();
            renderStats();
        } catch (e) {
            console.error('Failed to load stats:', e);
        }

        // Mode tabs
        document.querySelectorAll('.mode-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                setMode(this.dataset.mode);
            });
        });

        // Search inputs
        document.getElementById('operatorInput').addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() { doOperatorSearch(); }, 200);
        });
        document.getElementById('tailInput').addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() { doTailSearch(); }, 200);
        });
        document.getElementById('aircraftInput').addEventListener('input', function() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(function() { doAircraftSearch(); }, 200);
        });
        document.getElementById('proxSearchBtn').addEventListener('click', doProximitySearch);
        document.getElementById('addressInput').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') doProximitySearch();
        });

        // Detail overlay
        document.getElementById('detailOverlay').addEventListener('click', function(e) {
            if (e.target === this) closeDetail();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeDetail();
        });
    }

    function renderStats() {
        document.getElementById('statIncidents').textContent = fmtInt(stats.total_incidents);
        document.getElementById('statDeaths').textContent = fmtInt(stats.total_deaths);
        document.getElementById('statOperators').textContent = fmtInt(stats.unique_operators);
        document.getElementById('statYears').textContent = stats.year_range[0] || '--';
    }

    function setMode(mode) {
        currentMode = mode;
        document.querySelectorAll('.mode-tab').forEach(function(t) {
            t.classList.toggle('active', t.dataset.mode === mode);
        });
        document.getElementById('searchOperator').style.display = mode === 'operator' ? '' : 'none';
        document.getElementById('searchTail').style.display = mode === 'tail' ? '' : 'none';
        document.getElementById('searchAircraft').style.display = mode === 'aircraft' ? '' : 'none';
        document.getElementById('searchProximity').style.display = mode === 'proximity' ? '' : 'none';
        document.getElementById('results').innerHTML = '';
    }

    // ---- Operator Search ----
    async function doOperatorSearch() {
        var query = document.getElementById('operatorInput').value.trim();
        if (query.length < 2) {
            document.getElementById('results').innerHTML = '';
            return;
        }

        var letter = query[0].toUpperCase();
        if (!/[A-Z]/.test(letter)) letter = '_';
        var shardKey = 'op_' + letter.toLowerCase();

        if (!indexCache[shardKey]) {
            document.getElementById('results').innerHTML =
                '<div class="loading"><span class="spinner"></span>Loading index...</div>';
            try {
                var resp = await fetch(BASE + 'data/i/' + shardKey + '.json');
                indexCache[shardKey] = await resp.json();
            } catch (e) {
                document.getElementById('results').innerHTML =
                    '<div class="loading">No operators found.</div>';
                return;
            }
        }

        var entries = indexCache[shardKey];
        var q = query.toUpperCase();
        var matches = [];

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var name = (e.n || '').toUpperCase();
            var key = (e.k || '').toUpperCase();
            if (name.indexOf(q) !== -1 || key.indexOf(q) !== -1) {
                var score = 0;
                if (name.indexOf(q) === 0 || key.indexOf(q) === 0) score = 2;
                else score = 1;
                score += Math.log10(e.c + 1) / 5;
                matches.push({ entry: e, score: score });
            }
        }

        matches.sort(function(a, b) { return b.score - a.score; });
        var shown = matches.slice(0, 50);

        if (shown.length === 0) {
            document.getElementById('results').innerHTML =
                '<div class="loading">No operators found matching "' + esc(query) + '"</div>';
            return;
        }

        var html = '<div class="results-count">' + fmtInt(matches.length) +
            ' operator' + (matches.length !== 1 ? 's' : '') + ' found' +
            (matches.length > 50 ? ' (showing top 50)' : '') + '</div>';

        shown.forEach(function(m) {
            var e = m.entry;
            html += '<div class="result-card" data-type="op" data-key="' + esc(e.k) + '" data-shard="' + esc(e.h) + '">';
            if (e.f > 0) html += '<span class="result-badge badge-fatal">' + e.f + ' deaths</span>';
            html += '<span class="result-badge badge-incidents">' + e.c + ' incidents</span>';
            html += '<div class="result-name">' + esc(e.n) + '</div>';
            html += '<div class="result-meta">';
            if (e.y0 && e.y1) html += e.y0 + '–' + e.y1;
            if (e.s > 0) html += ' &middot; ' + e.s + ' serious injuries';
            html += '</div></div>';
        });

        document.getElementById('results').innerHTML = html;
        bindResultCards();
    }

    // ---- Tail Number Search ----
    async function doTailSearch() {
        var query = document.getElementById('tailInput').value.trim().toUpperCase();
        if (query.length < 2) {
            document.getElementById('results').innerHTML = '';
            return;
        }

        var letter = query[0];
        if (!/[A-Z0-9]/.test(letter)) letter = '_';
        var shardKey = 'tn_' + letter.toLowerCase();

        if (!indexCache[shardKey]) {
            document.getElementById('results').innerHTML =
                '<div class="loading"><span class="spinner"></span>Loading index...</div>';
            try {
                var resp = await fetch(BASE + 'data/i/' + shardKey + '.json');
                indexCache[shardKey] = await resp.json();
            } catch (e) {
                document.getElementById('results').innerHTML =
                    '<div class="loading">No aircraft found.</div>';
                return;
            }
        }

        var entries = indexCache[shardKey];
        var matches = [];

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.t.indexOf(query) !== -1) {
                var score = e.t === query ? 10 : (e.t.indexOf(query) === 0 ? 5 : 1);
                score += e.c / 10;
                matches.push({ entry: e, score: score });
            }
        }

        matches.sort(function(a, b) { return b.score - a.score; });
        var shown = matches.slice(0, 50);

        if (shown.length === 0) {
            document.getElementById('results').innerHTML =
                '<div class="loading">No aircraft found matching "' + esc(query) + '"</div>';
            return;
        }

        var html = '<div class="results-count">' + fmtInt(matches.length) +
            ' aircraft found' +
            (matches.length > 50 ? ' (showing top 50)' : '') + '</div>';

        shown.forEach(function(m) {
            var e = m.entry;
            html += '<div class="result-card" data-type="tn" data-key="' + esc(e.t) + '" data-shard="' + esc(e.h) + '">';
            html += '<span class="result-badge badge-incidents">' + e.c + ' incidents</span>';
            if (e.f > 0) html += '<span class="result-badge badge-fatal">' + e.f + ' deaths</span>';
            html += '<div class="result-name">' + esc(e.t) + '</div>';
            html += '<div class="result-meta">';
            html += esc(e.m + ' ' + (e.md || ''));
            if (e.op && e.op.length > 0) html += ' &middot; ' + esc(e.op[0]);
            if (e.y0 && e.y1) html += ' &middot; ' + e.y0 + '–' + e.y1;
            html += '</div></div>';
        });

        document.getElementById('results').innerHTML = html;
        bindResultCards();
    }

    // ---- Aircraft Type Search ----
    async function doAircraftSearch() {
        var query = document.getElementById('aircraftInput').value.trim();
        if (query.length < 2) {
            document.getElementById('results').innerHTML = '';
            return;
        }

        var letter = query[0].toUpperCase();
        if (!/[A-Z]/.test(letter)) letter = '_';
        var shardKey = 'mm_' + letter.toLowerCase();

        if (!indexCache[shardKey]) {
            document.getElementById('results').innerHTML =
                '<div class="loading"><span class="spinner"></span>Loading index...</div>';
            try {
                var resp = await fetch(BASE + 'data/i/' + shardKey + '.json');
                indexCache[shardKey] = await resp.json();
            } catch (e) {
                document.getElementById('results').innerHTML =
                    '<div class="loading">No aircraft types found.</div>';
                return;
            }
        }

        var entries = indexCache[shardKey];
        var q = query.toUpperCase();
        var matches = [];

        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var name = (e.n || '').toUpperCase();
            var key = (e.k || '').toUpperCase();
            if (name.indexOf(q) !== -1 || key.indexOf(q) !== -1) {
                var score = name.indexOf(q) === 0 ? 2 : 1;
                score += Math.log10(e.c + 1) / 5;
                matches.push({ entry: e, score: score });
            }
        }

        matches.sort(function(a, b) { return b.score - a.score; });
        var shown = matches.slice(0, 50);

        if (shown.length === 0) {
            document.getElementById('results').innerHTML =
                '<div class="loading">No aircraft types found matching "' + esc(query) + '"</div>';
            return;
        }

        var html = '<div class="results-count">' + fmtInt(matches.length) +
            ' aircraft type' + (matches.length !== 1 ? 's' : '') + ' found' +
            (matches.length > 50 ? ' (showing top 50)' : '') + '</div>';

        shown.forEach(function(m) {
            var e = m.entry;
            html += '<div class="result-card" data-type="mm" data-key="' + esc(e.k) + '" data-shard="' + esc(e.h) + '">';
            html += '<span class="result-badge badge-incidents">' + e.c + ' incidents</span>';
            if (e.f > 0) html += '<span class="result-badge badge-fatal">' + e.f + ' deaths</span>';
            html += '<div class="result-name">' + esc(e.n) + '</div>';
            html += '<div class="result-meta">';
            if (e.y0 && e.y1) html += e.y0 + '–' + e.y1;
            html += '</div></div>';
        });

        document.getElementById('results').innerHTML = html;
        bindResultCards();
    }

    // ---- Proximity Search ----
    async function doProximitySearch() {
        var addr = document.getElementById('addressInput').value.trim();
        if (!addr) return;
        var radius = parseInt(document.getElementById('radiusSelect').value);

        document.getElementById('results').innerHTML =
            '<div class="loading"><span class="spinner"></span>Geocoding address...</div>';

        // Geocode via Nominatim
        try {
            var url = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&limit=1&q=' +
                encodeURIComponent(addr);
            var resp = await fetch(url, { headers: { 'User-Agent': 'AviationSafetyCheck/1.0' } });
            var geo = await resp.json();
            if (!geo || geo.length === 0) {
                document.getElementById('results').innerHTML =
                    '<div class="loading">Could not geocode that address. Try a US city and state.</div>';
                return;
            }

            var lat = parseFloat(geo[0].lat);
            var lon = parseFloat(geo[0].lon);
            var displayName = geo[0].display_name.split(',').slice(0, 3).join(',');

            // Determine which state shards to load
            // Load nearby states based on lat/lon
            await searchNearby(lat, lon, radius, displayName);
        } catch (e) {
            document.getElementById('results').innerHTML =
                '<div class="loading">Geocoding failed. Try again.</div>';
        }
    }

    async function searchNearby(lat, lon, radius, displayName) {
        document.getElementById('results').innerHTML =
            '<div class="loading"><span class="spinner"></span>Searching nearby incidents...</div>';

        // We need to determine which state files to load
        // Load all state files that could contain records within the radius
        // For simplicity, try to determine the state from the address
        // and load it + neighboring states

        // Map states to approximate centroids for filtering
        var stateList = ['al','ak','az','ar','ca','co','ct','de','fl','ga',
            'hi','id','il','in','ia','ks','ky','la','me','md',
            'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
            'nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
            'sd','tn','tx','ut','vt','va','wa','wv','wi','wy',
            'dc','gm','pr','vi','as'];

        // Strategy: load all state files and filter by distance
        // This is feasible because state files are small
        // But first try loading just nearby states using a bounding box
        var latRange = radius / 69.0;  // ~69 miles per degree lat
        var lonRange = radius / (69.0 * Math.cos(lat * Math.PI / 180));

        var allNearby = [];
        var loaded = 0;
        var errors = 0;

        // Load all states (they're small files)
        var promises = stateList.map(function(st) {
            if (proxCache[st]) {
                return Promise.resolve(proxCache[st]);
            }
            return fetch(BASE + 'data/p/' + st + '.json')
                .then(function(r) { return r.json(); })
                .then(function(data) { proxCache[st] = data; return data; })
                .catch(function() { return []; });
        });

        var stateData = await Promise.all(promises);

        for (var s = 0; s < stateData.length; s++) {
            var records = stateData[s];
            if (!records) continue;
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                // Quick bounding box filter
                if (Math.abs(r.la - lat) > latRange || Math.abs(r.lo - lon) > lonRange) continue;
                var dist = haversine(lat, lon, r.la, r.lo);
                if (dist <= radius) {
                    allNearby.push({ record: r, distance: dist });
                }
            }
        }

        // Sort by distance
        allNearby.sort(function(a, b) { return a.distance - b.distance; });

        if (allNearby.length === 0) {
            document.getElementById('results').innerHTML =
                '<div class="loading">No aviation incidents found within ' + radius + ' miles of ' + esc(displayName) + '</div>';
            return;
        }

        var shown = allNearby.slice(0, 100);
        var fatalCount = allNearby.filter(function(x) { return x.record.f > 0; }).length;
        var totalDeaths = allNearby.reduce(function(sum, x) { return sum + (x.record.f || 0); }, 0);

        var html = '<div class="results-count">' +
            fmtInt(allNearby.length) + ' incidents within ' + radius + ' miles of ' + esc(displayName) +
            (fatalCount > 0 ? ' &middot; ' + fatalCount + ' fatal (' + totalDeaths + ' deaths)' : '') +
            (allNearby.length > 100 ? ' &middot; showing nearest 100' : '') +
            '</div>';

        shown.forEach(function(item) {
            var r = item.record;
            var sev = sevLabel(r.sev);
            html += '<div class="prox-card">';
            html += '<div class="incident-header">';
            html += '<div><span class="incident-date">' + fmtDate(r.d) + '</span>';
            html += ' <span class="prox-distance">' + item.distance.toFixed(1) + ' mi</span></div>';
            html += '<span class="incident-severity ' + sev.cls + '">' + sev.text + '</span>';
            html += '</div>';
            html += '<div class="incident-location">' + esc(r.c) + '</div>';
            html += '<div class="incident-aircraft">' + esc(r.m);
            if (r.t) html += ' (' + esc(r.t) + ')';
            if (r.op) html += ' — ' + esc(r.op);
            html += '</div>';
            if (r.f > 0) html += '<div style="font-size:0.8rem;color:#dd5544;">' + r.f + ' fatal</div>';
            if (r.ntsb) {
                html += '<a class="ntsb-link" href="https://data.ntsb.gov/carol-main-public/basic-search" target="_blank">' +
                    'NTSB ' + esc(r.ntsb) + '</a>';
            }
            html += '</div>';
        });

        document.getElementById('results').innerHTML = html;
    }

    // ---- Detail Loading ----
    function bindResultCards() {
        document.querySelectorAll('.result-card').forEach(function(el) {
            el.addEventListener('click', function() {
                loadDetail(this.dataset.type, this.dataset.key, this.dataset.shard);
            });
        });
    }

    async function loadDetail(type, key, shardHex) {
        var cacheKey = type + '/' + shardHex;

        if (!detailCache[cacheKey]) {
            showDetailLoading();
            try {
                var resp = await fetch(BASE + 'data/d/' + type + '/' + shardHex + '.json');
                detailCache[cacheKey] = await resp.json();
            } catch (e) {
                document.getElementById('detailPanel').innerHTML =
                    '<button class="detail-close">&times;</button>' +
                    '<div class="loading">Detail not available. Operators with fewer than 2 incidents ' +
                    'and tail numbers with only 1 record don\'t have full breakdowns.</div>';
                document.getElementById('detailOverlay').classList.add('active');
                bindDetailClose();
                return;
            }
        }

        var record = detailCache[cacheKey][key];
        if (!record) {
            document.getElementById('detailPanel').innerHTML =
                '<button class="detail-close">&times;</button>' +
                '<div class="loading">Detail not available for this entry.</div>';
            document.getElementById('detailOverlay').classList.add('active');
            bindDetailClose();
            return;
        }

        if (type === 'op') renderOperatorDetail(record);
        else if (type === 'tn') renderTailDetail(record);
        else if (type === 'mm') renderAircraftDetail(record);
    }

    function showDetailLoading() {
        document.getElementById('detailPanel').innerHTML =
            '<button class="detail-close">&times;</button>' +
            '<div class="loading"><span class="spinner"></span>Loading details...</div>';
        document.getElementById('detailOverlay').classList.add('active');
        bindDetailClose();
    }

    function renderOperatorDetail(r) {
        var html = '<button class="detail-close">&times;</button>';
        html += '<div class="detail-name">' + esc(r.name) + '</div>';
        html += '<div class="detail-sub">Aviation Operator — NTSB Accident Records</div>';

        html += '<div class="detail-stats">';
        html += '<div class="stat"><div class="detail-stat-value">' + r.total + '</div><div class="detail-stat-label">Incidents</div></div>';
        html += '<div class="stat"><div class="detail-stat-value fatal">' + r.fatal_incidents + '</div><div class="detail-stat-label">Fatal</div></div>';
        html += '<div class="stat"><div class="detail-stat-value fatal">' + r.total_deaths + '</div><div class="detail-stat-label">Deaths</div></div>';
        html += '<div class="stat"><div class="detail-stat-value">' + r.total_serious + '</div><div class="detail-stat-label">Serious Injuries</div></div>';
        html += '</div>';

        // Yearly trend
        if (r.yearly && r.yearly.length > 0) {
            html += '<div class="detail-section-title">Incidents by Year</div>';
            r.yearly.forEach(function(y) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + y[0] + '</div>' +
                    '<div class="breakdown-value">' + y[1] + '</div></div>';
            });
        }

        // Aircraft types
        if (r.aircraft_types && r.aircraft_types.length > 0) {
            html += '<div class="detail-section-title">Aircraft Types</div>';
            r.aircraft_types.forEach(function(t) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + esc(t[0]) + '</div>' +
                    '<div class="breakdown-value">' + t[1] + '</div></div>';
            });
        }

        // States
        if (r.states && r.states.length > 0) {
            html += '<div class="detail-section-title">States</div>';
            r.states.forEach(function(s) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + esc(s[0]) + '</div>' +
                    '<div class="breakdown-value">' + s[1] + '</div></div>';
            });
        }

        // Recent incidents
        html += renderIncidents(r.incidents, 'Recent Incidents');

        document.getElementById('detailPanel').innerHTML = html;
        document.getElementById('detailOverlay').classList.add('active');
        bindDetailClose();
    }

    function renderTailDetail(r) {
        var html = '<button class="detail-close">&times;</button>';
        html += '<div class="detail-name">' + esc(r.tail) + '</div>';
        html += '<div class="detail-sub">' + esc(r.make + ' ' + r.model) + '</div>';

        html += '<div class="detail-stats">';
        html += '<div class="stat"><div class="detail-stat-value">' + r.total + '</div><div class="detail-stat-label">Incidents</div></div>';
        html += '<div class="stat"><div class="detail-stat-value fatal">' + r.total_deaths + '</div><div class="detail-stat-label">Deaths</div></div>';
        html += '</div>';

        if (r.operators && r.operators.length > 0) {
            html += '<div class="detail-section-title">Operators</div>';
            r.operators.forEach(function(op) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + esc(op) + '</div></div>';
            });
        }

        html += renderIncidents(r.incidents, 'Incident History');

        document.getElementById('detailPanel').innerHTML = html;
        document.getElementById('detailOverlay').classList.add('active');
        bindDetailClose();
    }

    function renderAircraftDetail(r) {
        var html = '<button class="detail-close">&times;</button>';
        html += '<div class="detail-name">' + esc(r.name) + '</div>';
        html += '<div class="detail-sub">Aircraft Type — NTSB Accident Records</div>';

        html += '<div class="detail-stats">';
        html += '<div class="stat"><div class="detail-stat-value">' + r.total + '</div><div class="detail-stat-label">Incidents</div></div>';
        html += '<div class="stat"><div class="detail-stat-value fatal">' + r.fatal_incidents + '</div><div class="detail-stat-label">Fatal</div></div>';
        html += '<div class="stat"><div class="detail-stat-value fatal">' + r.total_deaths + '</div><div class="detail-stat-label">Deaths</div></div>';
        html += '</div>';

        if (r.yearly && r.yearly.length > 0) {
            html += '<div class="detail-section-title">Incidents by Year</div>';
            r.yearly.forEach(function(y) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + y[0] + '</div>' +
                    '<div class="breakdown-value">' + y[1] + '</div></div>';
            });
        }

        if (r.operators && r.operators.length > 0) {
            html += '<div class="detail-section-title">Top Operators</div>';
            r.operators.forEach(function(o) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + esc(o[0]) + '</div>' +
                    '<div class="breakdown-value">' + o[1] + '</div></div>';
            });
        }

        if (r.states && r.states.length > 0) {
            html += '<div class="detail-section-title">States</div>';
            r.states.forEach(function(s) {
                html += '<div class="breakdown-row"><div class="breakdown-label">' + esc(s[0]) + '</div>' +
                    '<div class="breakdown-value">' + s[1] + '</div></div>';
            });
        }

        html += renderIncidents(r.incidents, 'Recent Incidents');

        document.getElementById('detailPanel').innerHTML = html;
        document.getElementById('detailOverlay').classList.add('active');
        bindDetailClose();
    }

    function renderIncidents(incidents, title) {
        if (!incidents || incidents.length === 0) return '';
        var html = '<div class="detail-section-title">' + title + '</div>';
        incidents.forEach(function(inc) {
            var sev = sevLabel(inc.sev);
            html += '<div class="incident-card">';
            html += '<div class="incident-header">';
            html += '<span class="incident-date">' + fmtDate(inc.d) + '</span>';
            html += '<span class="incident-severity ' + sev.cls + '">' + sev.text;
            if (inc.f > 0) html += ' (' + inc.f + ' fatal)';
            html += '</span>';
            html += '</div>';
            var loc = '';
            if (inc.c) loc += inc.c;
            if (inc.s) loc += (loc ? ', ' : '') + inc.s;
            if (loc) html += '<div class="incident-location">' + esc(loc) + '</div>';
            if (inc.m) {
                html += '<div class="incident-aircraft">' + esc(inc.m);
                if (inc.t) html += ' (' + esc(inc.t) + ')';
                if (inc.op) html += ' — ' + esc(inc.op);
                html += '</div>';
            }
            if (inc.cause) {
                html += '<div class="incident-cause">' + esc(inc.cause) + '</div>';
            }
            if (inc.ntsb) {
                html += '<a class="ntsb-link" href="https://data.ntsb.gov/carol-main-public/basic-search" target="_blank">' +
                    'NTSB Report: ' + esc(inc.ntsb) + ' &rarr;</a>';
            }
            html += '</div>';
        });
        return html;
    }

    function bindDetailClose() {
        var btn = document.querySelector('.detail-close');
        if (btn) btn.addEventListener('click', closeDetail);
    }

    window.closeDetail = function() {
        document.getElementById('detailOverlay').classList.remove('active');
    };

    init();
})();
