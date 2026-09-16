// ==UserScript==
// @name         2D-3D Screen 
// @namespace    http://tampermonkey.net/
// @version      7.4
// @description  WebXR VR - with firefly forest environment
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    console.log('WebXR VR script started');

    let btn, depthSlider, depthLabel;
    let xrSession = null;
    let xrRefSpace = null;
    let gl = null;
    let xrLayer = null;
    let videoTexture = null;
    let videoEl = null;
    let prog = null;
    let posLoc, uvLoc;
    let quadBuf = null;

    // Environment
    let envProg = null;
    let skyVertBuf, skyIndexBuf, skyIndexCount;
    let treeVertBuf, treeIndexBuf, treeIndexCount;
    let fireflyProg = null;
    let fireflyBuf = null;
    let fireflyCount = 0;
    let fireflyData = null;

    // == TUNING ==
    const PLANE_DISTANCE = 4.7;
    const PLANE_WIDTH    = 3.5;
    const VERT_SCALE     = 1.15;
    const DEFAULT_DEPTH  = 0.09;
    // ============

    let depth = DEFAULT_DEPTH;
    let startTime = 0;

    // Launcher overlay

    // ---- Bar container and input controller ----
    const BAR_ID = "__vr_bar";
    let bar = null;
    let fadeTimer = null;
    let visible = true;
    let slDrag = false;
    const USEP = ('PointerEvent' in window);

    function applyVis() {
        if (!bar) return;
        bar.style.setProperty('opacity', visible ? '1' : '0', 'important');
        bar.style.setProperty('pointer-events', visible ? 'auto' : 'none', 'important');
    }
    function showBar() { visible = true; applyVis(); }
    function hideBar() { visible = false; applyVis(); }
    function pokeBar() { showBar(); if (fadeTimer) clearTimeout(fadeTimer); fadeTimer = setTimeout(hideBar, 5000); }

    function inEl(e, el) {
        if (!el) return false;
        const p = e.composedPath ? e.composedPath() : null;
        if (p && p.length) return p.indexOf(el) >= 0;
        const t = e.target;
        return el === t || (el.contains && el.contains(t));
    }

    function evX(e) {
        if (e.clientX != null) return e.clientX;
        const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
        return t ? t.clientX : null;
    }

    function setSliderFromX(x) {
        if (x == null || !depthSlider) return;
        const r = depthSlider.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
        const val = f * parseFloat(depthSlider.max);
        const step = parseFloat(depthSlider.step) || 0.001;
        const snapped = Math.round(val / step) * step;
        depthSlider.value = String(Math.min(parseFloat(depthSlider.max), Math.max(0, snapped)));
        depth = parseFloat(depthSlider.value);
        localStorage.setItem('xrDepth', String(depth));
        if (depthLabel) depthLabel.textContent = '3D Depth: ' + depth.toFixed(3);
    }

    function eat(e) {
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
    }

    function ctrlDown(e) {
        if (!bar) return;
        if (!inEl(e, bar)) return;
        eat(e);
        pokeBar();
        if (inEl(e, depthSlider)) {
            slDrag = true;
            setSliderFromX(evX(e));
            return;
        }
        if (inEl(e, btn)) {
            window._btnPressed = true;
        }
    }

    function ctrlMove(e) {
        if (!slDrag) return;
        eat(e);
        setSliderFromX(evX(e));
        pokeBar();
    }

    function ctrlUp(e) {
        if (slDrag) {
            eat(e);
            slDrag = false;
            pokeBar();
            return;
        }
        if (!bar || !inEl(e, bar)) return;
        eat(e);
        if (window._btnPressed && inEl(e, btn)) {
            window._btnPressed = false;
            toggleVR();
        } else {
            window._btnPressed = false;
        }
        pokeBar();
    }

    // ---- Capture listeners ----
    (USEP ? ['pointerdown'] : ['touchstart', 'mousedown']).forEach(function(ev) {
        window.addEventListener(ev, ctrlDown, true);
    });
    (USEP ? ['pointermove'] : ['touchmove', 'mousemove']).forEach(function(ev) {
        window.addEventListener(ev, ctrlMove, true);
    });
    (USEP ? ['pointerup', 'pointercancel'] : ['touchend', 'touchcancel', 'mouseup']).forEach(function(ev) {
        window.addEventListener(ev, ctrlUp, true);
    });

    // Tap anywhere to reveal bar
    window.addEventListener('pointerdown', function(e) {
        if (bar && !visible && !inEl(e, bar)) pokeBar();
    }, true);

    // ---- Ensure bar persists ----
    function ensureBar() {
        const host = document.body || document.documentElement;
        if (!host) return;
        let existing = document.getElementById(BAR_ID);
        if (existing && existing !== bar) {
            existing.remove();
            existing = null;
        }
        if (!bar || !bar.isConnected) {
            console.log('ensureBar: building new bar');
            buildBar();
            visible = true;
        }
        if (host.lastElementChild !== bar) {
            try { host.appendChild(bar); } catch(e) { console.error('append failed', e); }
        }
        applyVis();
    }

    function buildBar() {
        const old = document.getElementById(BAR_ID);
        if (old) old.remove();

        bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.setAttribute('style', [
            'position:fixed !important', 'right:14px !important', 'bottom:18px !important',
            'left:auto !important', 'top:auto !important', 'z-index:2147483647 !important',
            'display:flex !important', 'visibility:visible !important', 'opacity:1 !important',
            'pointer-events:auto !important', 'transform:none !important', 'clip:auto !important',
            'gap:10px', 'align-items:center', 'background:rgba(0,0,0,0.6)',
            'padding:8px 12px', 'border-radius:10px', 'font:15px sans-serif', 'color:#fff',
            'margin:0', 'transition:opacity 0.4s ease', 'width:auto', 'height:auto',
            'max-width:none'
        ].join(';'));

        btn = document.createElement('button');
        btn.textContent = 'VR: OFF';
        btn.style.cssText = 'background:#107c10;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer;font:15px sans-serif';

        depthSlider = document.createElement('input');
        depthSlider.type = 'range';
        depthSlider.min = '0';
        depthSlider.max = '0.20';
        depthSlider.step = '0.001';
        depthSlider.value = String(depth);
        depthSlider.style.cssText = 'width:160px;accent-color:#107c10;';

        depthLabel = document.createElement('span');
        depthLabel.textContent = '3D Depth: ' + depth.toFixed(3);
        depthLabel.style.cssText = 'color:#9fe;font:12px monospace;min-width:80px';

        bar.appendChild(btn);
        bar.appendChild(depthSlider);
        bar.appendChild(depthLabel);

        bar.addEventListener('click', function(e) { e.stopPropagation(); }, true);
        bar.addEventListener('pointerdown', function(e) { e.stopPropagation(); pokeBar(); }, true);

        return bar;
    }

    function showVRControls() {}
    function hideVRControls() {}

    function waitForBody() {
        if (document.body) setup();
        else setTimeout(waitForBody, 100);
    }

    function setup() {
        console.log('setup: running');
        const cursorFix = document.createElement('style');
        cursorFix.textContent = '*, *:hover { cursor: auto !important; }';
        (document.head || document.documentElement).appendChild(cursorFix);

        ensureBar();
        pokeBar();
        setInterval(ensureBar, 500);
        try {
            new MutationObserver(function() { ensureBar(); })
                .observe(document.documentElement, { childList: true, subtree: true });
        } catch(e) {}

        window.addEventListener('mousedown', (e) => {
            if (e.button === 2) {
                e.preventDefault();
                e.stopPropagation();
                toggleVR();
            }
        }, true);

        window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, true);

        if (!navigator.xr) {
            btn.textContent = 'WebXR N/A';
            btn.style.background = '#888';
        }
        console.log('setup: finished');
    }

    // ==================== FIXED findVideo() ====================
    function findVideo() {
        // 1. Look for <video> first (Moonlight, GFN, Plex)
        let all = [...document.querySelectorAll('video')];
        let valid = all.filter(v => v.videoWidth > 0);
        if (valid.length > 0) {
            return valid.reduce((a, b) => a.videoWidth > b.videoWidth ? a : b);
        }

        // 2. Look for <img> with stream-related src (IP Webcam)
        all = [...document.querySelectorAll('img')];
        let streamImgs = all.filter(img => 
            img.naturalWidth > 0 && 
            img.naturalHeight > 0 && 
            img.src && 
            (img.src.includes('mjpeg') || img.src.includes('stream') || img.src.includes('video') || img.src.includes('camera'))
        );
        if (streamImgs.length > 0) {
            return streamImgs.reduce((a, b) => a.naturalWidth > b.naturalWidth ? a : b);
        }

        // 3. Fallback: any large image (min 100px to avoid tiny icons/arrows)
        valid = all.filter(img => img.naturalWidth > 100 && img.naturalHeight > 100 && img.src);
        if (valid.length > 0) {
            return valid.reduce((a, b) => a.naturalWidth > b.naturalWidth ? a : b);
        }

        // 4. Fallback to canvas
        all = [...document.querySelectorAll('canvas')];
        valid = all.filter(c => c.width > 100);
        return valid.length ? valid.reduce((a,b) => a.width > b.width ? a : b) : null;
    }

    async function recenter() {
        if (!xrSession) return;
        xrRefSpace = await xrSession.requestReferenceSpace('local')
            .catch(() => xrSession.requestReferenceSpace('viewer'))
            .catch(e => console.warn('Recenter failed:', e));
    }

    async function toggleVR() {
        if (xrSession) { await xrSession.end(); return; }

        if (!navigator.xr) { alert('Use Edge browser for WebXR'); return; }
        if (!await navigator.xr.isSessionSupported('immersive-vr')) {
            alert('Immersive VR not supported on this device'); return;
        }

        videoEl = findVideo();
        if (!videoEl) { alert('Start a video first, then tap VR'); return; }

        console.log(`VR source: ${videoEl.videoWidth || videoEl.naturalWidth || videoEl.width}x${videoEl.videoHeight || videoEl.naturalHeight || videoEl.height}`);

        try {
            try {
                xrSession = await navigator.xr.requestSession('immersive-vr', {
                    optionalFeatures: ['local', 'local-floor', 'viewer']
                });
            } catch (eInner) {
                xrSession = await navigator.xr.requestSession('immersive-vr');
            }
        } catch(e) {
            alert('VR session failed: ' + e.message +
                '\n\nIf it says "configuration not supported", the IP Webcam page is NOT a secure context. Add its URL (http://IP:PORT) to edge://flags #unsafely-treat-insecure-origin-as-secure, relaunch, and retry.');
            return;
        }

        btn.textContent = 'VR: ON';
        showVRControls();

        const canvas = document.createElement('canvas');
        canvas.style.display = 'none';
        document.body.appendChild(canvas);

        gl = canvas.getContext('webgl', {
            xrCompatible: true,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance'
        });
        if (!gl) { xrSession.end(); return; }
        await gl.makeXRCompatible();

        xrLayer = new XRWebGLLayer(xrSession, gl, {
            framebufferScaleFactor: 1.0,
            antialias: true
        });
        xrSession.updateRenderState({ baseLayer: xrLayer });
        try { xrRefSpace = await xrSession.requestReferenceSpace('local'); }
        catch(_) { xrRefSpace = await xrSession.requestReferenceSpace('viewer'); }

        buildShader();
        buildQuad();
        buildTexture();
        cacheUniforms();

        buildEnvironment();

        startTime = performance.now();

        xrSession.addEventListener('end', onEnd);
        xrSession.requestAnimationFrame(onFrame);
    }

    function onEnd() {
        [xrSession, xrLayer, gl, prog, quadBuf, videoTexture, xrRefSpace,
         envProg, skyVertBuf, skyIndexBuf, treeVertBuf, treeIndexBuf,
         fireflyProg, fireflyBuf, fireflyData]
            = Array(15).fill(null);
        fireflyCount = 0;
        btn.textContent = 'VR: OFF';
        hideVRControls();
    }

    // ---- Shaders (unchanged) ----
    const VS = `
        attribute vec3 aPos;
        attribute vec2 aUV;
        uniform mat4 uMVP;
        uniform float uEyeShift;
        varying vec2 vUV;
        void main() {
            vUV = vec2(aUV.x + uEyeShift, aUV.y);
            gl_Position = uMVP * vec4(aPos, 1.0);
        }
    `;

    const FS = `
        precision highp float;
        uniform sampler2D uTex;
        uniform float uDepth;
        uniform float uTexel;
        uniform bool uRightEye;
        varying vec2 vUV;

        float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

        float depthLum(vec2 uv){
            float s  = luma(texture2D(uTex, vec2(clamp(uv.x - 3.0*uTexel, 0.001, 0.999), uv.y)).rgb);
            s += luma(texture2D(uTex, vec2(clamp(uv.x - 1.5*uTexel, 0.001, 0.999), uv.y)).rgb);
            s += luma(texture2D(uTex, uv).rgb) * 2.0;
            s += luma(texture2D(uTex, vec2(clamp(uv.x + 1.5*uTexel, 0.001, 0.999), uv.y)).rgb);
            s += luma(texture2D(uTex, vec2(clamp(uv.x + 3.0*uTexel, 0.001, 0.999), uv.y)).rgb);
            return s / 6.0;
        }

        void main() {
            vec2 uv = clamp(vUV, 0.001, 0.999);
            vec4 col = texture2D(uTex, uv);
            if (uRightEye && uDepth > 0.0) {
                float convergenceOffset = 0.02;
                float lum   = depthLum(uv);
                float shift = (lum - 0.5) * uDepth * 0.3 + (convergenceOffset * uDepth);
                shift = clamp(shift, -0.06, 0.06);
                vec2 uv2 = clamp(vec2(uv.x + shift, uv.y), 0.001, 0.999);
                vec4 col2 = texture2D(uTex, uv2);
                float d = abs(lum - luma(col2.rgb));
                float w = 1.0 - smoothstep(0.12, 0.34, d);
                col = vec4(mix(col.rgb, col2.rgb, w), col.a);
            }
            gl_FragColor = col;
        }
    `;

    function buildShader() {
        function compile(type, src) {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                console.error(gl.getShaderInfoLog(s));
            return s;
        }
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        gl.useProgram(prog);
        posLoc = gl.getAttribLocation(prog, 'aPos');
        uvLoc  = gl.getAttribLocation(prog, 'aUV');
    }

    function buildQuad() {
        const vw = videoEl.naturalWidth || videoEl.videoWidth || 1920;
        const vh = videoEl.naturalHeight || videoEl.videoHeight || 1080;
        const aspect = vw / vh;
        const hw = PLANE_WIDTH / 2;
        const hh = (hw / aspect) * VERT_SCALE;
        const z  = -PLANE_DISTANCE;
        console.log(`Quad: ${PLANE_WIDTH}x${(hh*2).toFixed(2)}m  video:${vw}x${vh}  aspect:${aspect.toFixed(3)}  vertScale:${VERT_SCALE}`);
        quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -hw,  hh, z,  0.0, 0.0,
             hw,  hh, z,  1.0, 0.0,
            -hw, -hh, z,  0.0, 1.0,
             hw, -hh, z,  1.0, 1.0,
        ]), gl.STATIC_DRAW);
    }

    function buildTexture() {
        videoTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function mul4(a, b) {
        const o = new Float32Array(16);
        for (let i=0;i<4;i++)
            for (let j=0;j<4;j++)
                for (let k=0;k<4;k++)
                    o[j*4+i] += a[k*4+i] * b[j*4+k];
        return o;
    }

    let uMVP, uEyeShift, uDepthLoc, uRightEye, uTex, uTexelLoc;
    function cacheUniforms() {
        uMVP      = gl.getUniformLocation(prog, 'uMVP');
        uEyeShift = gl.getUniformLocation(prog, 'uEyeShift');
        uDepthLoc = gl.getUniformLocation(prog, 'uDepth');
        uTexelLoc = gl.getUniformLocation(prog, 'uTexel');
        uRightEye = gl.getUniformLocation(prog, 'uRightEye');
        uTex      = gl.getUniformLocation(prog, 'uTex');
    }

    // ---- Environment (unchanged) ----
    const ENV_VS = `
        attribute vec3 aPos;
        attribute vec3 aColor;
        uniform mat4 uMVP;
        varying vec3 vColor;
        void main() {
            vColor = aColor;
            gl_Position = uMVP * vec4(aPos, 1.0);
        }
    `;

    const ENV_FS = `
        precision highp float;
        varying vec3 vColor;
        void main() {
            gl_FragColor = vec4(vColor, 1.0);
        }
    `;

    const FIREFLY_VS = `
        attribute vec3 aPos;
        attribute float aPhase;
        uniform mat4 uMVP;
        uniform float uTime;
        varying float vGlow;
        void main() {
            vec3 p = aPos;
            p.y += sin(uTime * 0.7 + aPhase * 6.2831) * 0.08;
            p.x += cos(uTime * 0.5 + aPhase * 6.2831) * 0.05;
            vGlow = 0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * 2.0 + aPhase * 20.0));
            gl_Position = uMVP * vec4(p, 1.0);
            gl_PointSize = 6.0 + vGlow * 4.0;
        }
    `;

    const FIREFLY_FS = `
        precision highp float;
        varying float vGlow;
        void main() {
            vec2 d = gl_PointCoord - 0.5;
            float r = length(d);
            if (r > 0.5) discard;
            float falloff = 1.0 - smoothstep(0.0, 0.5, r);
            vec3 col = vec3(0.85, 1.0, 0.45) * vGlow;
            gl_FragColor = vec4(col, falloff * vGlow);
        }
    `;

    function compileEnvShader(vs, fs) {
        function compile(type, src) {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                console.error(gl.getShaderInfoLog(s));
            return s;
        }
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        return p;
    }

    function buildEnvironment() {
        envProg = compileEnvShader(ENV_VS, ENV_FS);
        fireflyProg = compileEnvShader(FIREFLY_VS, FIREFLY_FS);
        buildSky();
        buildTrees();
        buildFireflies();
    }

    function buildSky() {
        const rings = 12, segs = 16, radius = 40;
        const verts = [];
        const indices = [];

        for (let r = 0; r <= rings; r++) {
            const theta = (r / rings) * Math.PI;
            const t = r / rings;
            const top    = [0.05, 0.10, 0.07];
            const bottom = [0.01, 0.01, 0.015];
            const cr = top[0] + (bottom[0]-top[0]) * t;
            const cg = top[1] + (bottom[1]-top[1]) * t;
            const cb = top[2] + (bottom[2]-top[2]) * t;

            for (let s = 0; s <= segs; s++) {
                const phi = (s / segs) * 2 * Math.PI;
                const x = radius * Math.sin(theta) * Math.cos(phi);
                const y = radius * Math.cos(theta);
                const z = radius * Math.sin(theta) * Math.sin(phi);
                verts.push(x, y, z, cr, cg, cb);
            }
        }
        for (let r = 0; r < rings; r++) {
            for (let s = 0; s < segs; s++) {
                const a = r * (segs+1) + s;
                const b = a + segs + 1;
                indices.push(a, b, a+1);
                indices.push(b, b+1, a+1);
            }
        }

        skyVertBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, skyVertBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

        skyIndexBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyIndexBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        skyIndexCount = indices.length;
    }

    function buildTrees() {
        const verts = [];
        const indices = [];
        let vi = 0;

        const treeCount = 24;
        for (let i = 0; i < treeCount; i++) {
            const angle = (i / treeCount) * Math.PI * 2 + (Math.random()-0.5)*0.3;
            const dist  = 8 + Math.random() * 22;
            const cx = Math.sin(angle) * dist;
            const cz = -Math.cos(angle) * dist;
            const height = 4 + Math.random() * 5;
            const trunkR = 0.2 + Math.random() * 0.15;
            const foliageR = 0.8 + Math.random() * 1.2;

            const fog = Math.min(1, dist / 30);
            const col = [
                0.03 + 0.01*(1-fog),
                0.05 + 0.02*(1-fog),
                0.025 + 0.01*(1-fog)
            ];

            const segsTrunk = 5;
            for (let s = 0; s < segsTrunk; s++) {
                const a0 = (s / segsTrunk) * Math.PI * 2;
                const a1 = ((s+1) / segsTrunk) * Math.PI * 2;
                const x0 = cx + Math.cos(a0)*trunkR, z0 = cz + Math.sin(a0)*trunkR;
                const x1 = cx + Math.cos(a1)*trunkR, z1 = cz + Math.sin(a1)*trunkR;

                verts.push(x0,0,z0, col[0],col[1],col[2]);
                verts.push(x1,0,z1, col[0],col[1],col[2]);
                verts.push(x0,height*0.5,z0, col[0],col[1],col[2]);
                verts.push(x1,height*0.5,z1, col[0],col[1],col[2]);

                indices.push(vi, vi+1, vi+2);
                indices.push(vi+1, vi+3, vi+2);
                vi += 4;
            }

            const foliageBase = height * 0.45;
            const foliageTop  = height;
            const segsFoliage = 8;
            const apex = vi;
            verts.push(cx, foliageTop, cz, col[0]*1.3, col[1]*1.4, col[2]*1.3);
            vi++;
            const baseStart = vi;
            for (let s = 0; s <= segsFoliage; s++) {
                const a = (s / segsFoliage) * Math.PI * 2;
                const x = cx + Math.cos(a)*foliageR;
                const z = cz + Math.sin(a)*foliageR;
                verts.push(x, foliageBase, z, col[0], col[1], col[2]);
                vi++;
            }
            for (let s = 0; s < segsFoliage; s++) {
                indices.push(apex, baseStart+s, baseStart+s+1);
            }
        }

        treeVertBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, treeVertBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

        treeIndexBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, treeIndexBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
        treeIndexCount = indices.length;
    }

    function buildFireflies() {
        fireflyCount = 80;
        const data = [];
        for (let i = 0; i < fireflyCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist  = 2 + Math.random() * 15;
            const x = Math.sin(angle) * dist;
            const z = -Math.cos(angle) * dist;
            const y = 0.2 + Math.random() * 3.5;
            const phase = Math.random();
            data.push(x, y, z, phase);
        }
        fireflyData = new Float32Array(data);
        fireflyBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, fireflyBuf);
        gl.bufferData(gl.ARRAY_BUFFER, fireflyData, gl.STATIC_DRAW);
    }

    function drawEnvironment(viewMVP) {
        gl.depthMask(false);
        gl.useProgram(envProg);
        const envAPos = gl.getAttribLocation(envProg, 'aPos');
        const envAColor = gl.getAttribLocation(envProg, 'aColor');
        const envMVP = gl.getUniformLocation(envProg, 'uMVP');

        gl.bindBuffer(gl.ARRAY_BUFFER, skyVertBuf);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyIndexBuf);
        const envStride = 24;
        gl.enableVertexAttribArray(envAPos);
        gl.vertexAttribPointer(envAPos, 3, gl.FLOAT, false, envStride, 0);
        gl.enableVertexAttribArray(envAColor);
        gl.vertexAttribPointer(envAColor, 3, gl.FLOAT, false, envStride, 12);
        gl.uniformMatrix4fv(envMVP, false, viewMVP);
        gl.drawElements(gl.TRIANGLES, skyIndexCount, gl.UNSIGNED_SHORT, 0);
        gl.depthMask(true);

        gl.bindBuffer(gl.ARRAY_BUFFER, treeVertBuf);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, treeIndexBuf);
        gl.enableVertexAttribArray(envAPos);
        gl.vertexAttribPointer(envAPos, 3, gl.FLOAT, false, envStride, 0);
        gl.enableVertexAttribArray(envAColor);
        gl.vertexAttribPointer(envAColor, 3, gl.FLOAT, false, envStride, 12);
        gl.uniformMatrix4fv(envMVP, false, viewMVP);
        gl.drawElements(gl.TRIANGLES, treeIndexCount, gl.UNSIGNED_SHORT, 0);

        gl.useProgram(fireflyProg);
        const ffAPos   = gl.getAttribLocation(fireflyProg, 'aPos');
        const ffAPhase = gl.getAttribLocation(fireflyProg, 'aPhase');
        const ffMVP    = gl.getUniformLocation(fireflyProg, 'uMVP');
        const ffTime   = gl.getUniformLocation(fireflyProg, 'uTime');

        gl.bindBuffer(gl.ARRAY_BUFFER, fireflyBuf);
        const ffStride = 16;
        gl.enableVertexAttribArray(ffAPos);
        gl.vertexAttribPointer(ffAPos, 3, gl.FLOAT, false, ffStride, 0);
        gl.enableVertexAttribArray(ffAPhase);
        gl.vertexAttribPointer(ffAPhase, 1, gl.FLOAT, false, ffStride, 12);

        gl.uniformMatrix4fv(ffMVP, false, viewMVP);
        gl.uniform1f(ffTime, (performance.now() - startTime) / 1000.0);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.drawArrays(gl.POINTS, 0, fireflyCount);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }

    // ---- Main loop ----
    function onFrame(t, frame) {
        if (!xrSession) return;
        xrSession.requestAnimationFrame(onFrame);

        const pose = frame.getViewerPose(xrRefSpace);
        if (!pose) return;

        gl.bindFramebuffer(gl.FRAMEBUFFER, xrLayer.framebuffer);
        gl.clearColor(0,0,0,1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        const isReady = videoEl.readyState !== undefined ? videoEl.readyState >= 2 : (videoEl.complete && videoEl.naturalWidth > 0);
        if (isReady) {
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
        }

        for (const view of pose.views) {
            const vp = xrLayer.getViewport(view);
            gl.viewport(vp.x, vp.y, vp.width, vp.height);

            const isRight  = view.eye === 'right';
            const eyeShift = isRight ? depth * 0.02 : -depth * 0.02;

            const viewMVP = mul4(view.projectionMatrix, view.transform.inverse.matrix);

            drawEnvironment(viewMVP);

            gl.useProgram(prog);
            gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);

            const stride = 20;
            gl.enableVertexAttribArray(posLoc);
            gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(uvLoc);
            gl.vertexAttribPointer(uvLoc,  2, gl.FLOAT, false, stride, 12);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            gl.uniform1i(uTex, 0);
            gl.uniform1f(uDepthLoc, depth);
            const vidWidth = videoEl.naturalWidth || videoEl.videoWidth || 1920;
            gl.uniform1f(uTexelLoc, 1.0 / Math.max(320, vidWidth));
            gl.uniform1f(uEyeShift, eyeShift);
            gl.uniform1i(uRightEye, isRight ? 1 : 0);
            gl.uniformMatrix4fv(uMVP, false, viewMVP);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    }

    waitForBody();
})();