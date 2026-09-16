// ==UserScript==
// @name         Bilateral 
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  WebXR VR - with firefly forest environment
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    let btn, recenterBtn, depthSlider, depthLabel, intensitySlider, intensityLabel;
    let intensity = parseFloat(localStorage.getItem('xrIntensity')) || 1.0;
    let xrSession = null;
    let xrRefSpace = null;
    let gl = null;
    let xrLayer = null;
    let videoTexture = null;
    let videoEl = null;
    let prog = null;
    let posLoc, uvLoc;
    let quadBuf = null;

    // Environment (sky + trees + fireflies)
    let envProg = null;
    let skyVertBuf, skyIndexBuf, skyIndexCount;
    let treeVertBuf, treeIndexBuf, treeIndexCount;
    let fireflyProg = null;
    let fireflyBuf = null;
    let fireflyCount = 0;
    let fireflyData = null; // CPU-side for animation

    // == TUNING ==
    const PLANE_DISTANCE = 4.7;
    const PLANE_WIDTH    = 3.5;
    const VERT_SCALE     = 1.11;
    const DEFAULT_DEPTH  = 0.09;
    // ============

    let depth = DEFAULT_DEPTH;
    let startTime = 0;


    function waitForBody() {
        if (document.body) setup();
        else setTimeout(waitForBody, 100);
    }

    function setup() {
        // ========== CURSOR FIX (always visible) ==========
        const cursorFix = document.createElement('style');
        cursorFix.textContent = '*, *:hover { cursor: auto !important; }';
        (document.head || document.documentElement).appendChild(cursorFix);

        // ========== VR BUTTONS ==========
        btn = document.createElement('button');
        btn.textContent = 'VR: OFF';
        btn.style.cssText = `
            position:fixed; bottom:20px; right:20px; z-index:999999;
            padding:12px 20px; background:#107c10; color:white;
            border:none; border-radius:8px; font-size:16px; cursor:pointer; opacity:0.9;
        `;
        btn.onclick = toggleVR;
        document.body.appendChild(btn);

        recenterBtn = document.createElement('button');
        recenterBtn.textContent = '⟳ Recenter';
        recenterBtn.style.cssText = `
            position:fixed; bottom:20px; right:140px; z-index:999999;
            padding:12px 20px; background:#0078d4; color:white;
            border:none; border-radius:8px; font-size:16px; cursor:pointer;
            opacity:0; pointer-events:none;
        `;
        recenterBtn.onclick = recenter;
        document.body.appendChild(recenterBtn);

        depthLabel = document.createElement('div');
        depthLabel.style.cssText = `
            position:fixed; bottom:130px; right:20px; z-index:999999;
            color:white; font-size:14px; font-family:sans-serif;
            background:rgba(0,0,0,0.5); padding:4px 8px; border-radius:4px;
            opacity:0;
        `;
        depthLabel.textContent = '3D Depth: ' + depth.toFixed(3);
        document.body.appendChild(depthLabel);

        depthSlider = document.createElement('input');
        depthSlider.type  = 'range';
        depthSlider.min   = '0';
        depthSlider.max   = '0.20';
        depthSlider.step  = '0.001';
        depthSlider.value = String(depth);
        depthSlider.style.cssText = `
            position:fixed; bottom:100px; right:20px; width:220px;
            z-index:999999; opacity:0; pointer-events:none; cursor:pointer;
            accent-color:#107c10;
        `;
        depthSlider.oninput = () => {
            depth = parseFloat(depthSlider.value);
            localStorage.setItem('xrDepth', String(depth));
            depthLabel.textContent = '3D Depth: ' + depth.toFixed(3);
        };
        document.body.appendChild(depthSlider);

        intensityLabel = document.createElement('div');
        intensityLabel.style.cssText = `
            position:fixed; bottom:185px; right:20px; z-index:999999;
            color:#9fe; font:12px monospace; opacity:0; pointer-events:none;
        `;
        intensityLabel.textContent = '3D Intensity: ' + intensity.toFixed(2);
        document.body.appendChild(intensityLabel);

        intensitySlider = document.createElement('input');
        intensitySlider.type  = 'range';
        intensitySlider.min   = '0';
        intensitySlider.max   = '2';
        intensitySlider.step  = '0.05';
        intensitySlider.value = String(intensity);
        intensitySlider.style.cssText = `
            position:fixed; bottom:160px; right:20px; width:220px;
            z-index:999999; opacity:0; pointer-events:none; cursor:pointer;
            accent-color:#107c10;
        `;
        intensitySlider.oninput = () => {
            intensity = parseFloat(intensitySlider.value);
            localStorage.setItem('xrIntensity', String(intensity));
            intensityLabel.textContent = '3D Intensity: ' + intensity.toFixed(2);
        };
        document.body.appendChild(intensitySlider);

        // ---- Mouse button controls ----
        // left=0 (normal), middle=1 (menu), right=2 (VR toggle), side=3/4
        window.addEventListener('mousedown', (e) => {
            if (e.button === 2) {            // RIGHT CLICK = enter/exit VR
                e.preventDefault();
                e.stopPropagation();
                toggleVR();
            }
        }, true);

        // Stop the browser context menu from popping up on right-click
        window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, true);

        // ============================================================

        if (!navigator.xr) {
            btn.textContent = 'WebXR N/A';
            btn.style.background = '#888';
        }
    }

    function showVRControls() {
        recenterBtn.style.opacity = '0.9';
        recenterBtn.style.pointerEvents = 'auto';
        depthSlider.style.opacity = '0.9';
        depthSlider.style.pointerEvents = 'auto';
        depthLabel.style.opacity = '1';
        intensitySlider.style.opacity = '0.9';
        intensitySlider.style.pointerEvents = 'auto';
        intensityLabel.style.opacity = '1';
    }

    function hideVRControls() {
        recenterBtn.style.opacity = '0';
        recenterBtn.style.pointerEvents = 'none';
        depthSlider.style.opacity = '0';
        depthSlider.style.pointerEvents = 'none';
        depthLabel.style.opacity = '0';
        intensitySlider.style.opacity = '0';
        intensitySlider.style.pointerEvents = 'none';
        intensityLabel.style.opacity = '0';
    }

    function findVideo() {
        const all = [...document.querySelectorAll('video')];
        const live = all.filter(v => v.videoWidth > 0 && !v.paused);
        const pool = live.length ? live : all.filter(v => v.videoWidth > 0);
        return pool.length
            ? pool.reduce((a,b) => a.videoWidth > b.videoWidth ? a : b)
            : null;
    }

    async function recenter() {
        if (!xrSession) return;
        xrRefSpace = await xrSession.requestReferenceSpace('local')
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

        console.log(`VR source: ${videoEl.videoWidth}x${videoEl.videoHeight}`);

        try {
            xrSession = await navigator.xr.requestSession('immersive-vr', {
                requiredFeatures: ['local']
            });
        } catch(e) { alert('VR session failed: ' + e.message); return; }

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
        xrRefSpace = await xrSession.requestReferenceSpace('local');

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

    // ----------------------------------------------------------------
    // Screen quad shader (video)
    // ----------------------------------------------------------------
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
        uniform float uIntensity;
        uniform float uTexel;
        uniform bool uRightEye;
        varying vec2 vUV;

        float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }

        // Bilateral (edge-preserving) depth: horizontal taps weighted by luma
        // similarity to the centre, so smoothing does NOT bleed across real depth
        // boundaries. Kills shimmer in flat areas while keeping depth edges crisp.
        float depthLum(vec2 uv){
            float c0 = luma(texture2D(uTex, uv).rgb);
            float wsum = 2.0;
            float acc  = c0 * 2.0;
            float s1 = luma(texture2D(uTex, vec2(clamp(uv.x - 1.5*uTexel, 0.001, 0.999), uv.y)).rgb);
            float s2 = luma(texture2D(uTex, vec2(clamp(uv.x + 1.5*uTexel, 0.001, 0.999), uv.y)).rgb);
            float s3 = luma(texture2D(uTex, vec2(clamp(uv.x - 3.0*uTexel, 0.001, 0.999), uv.y)).rgb);
            float s4 = luma(texture2D(uTex, vec2(clamp(uv.x + 3.0*uTexel, 0.001, 0.999), uv.y)).rgb);
            float sig = 0.12;
            float w1 = exp(-abs(s1-c0)/sig);       acc += s1*w1; wsum += w1;
            float w2 = exp(-abs(s2-c0)/sig);       acc += s2*w2; wsum += w2;
            float w3 = exp(-abs(s3-c0)/sig) * 0.6; acc += s3*w3; wsum += w3;
            float w4 = exp(-abs(s4-c0)/sig) * 0.6; acc += s4*w4; wsum += w4;
            return acc / wsum;
        }

        void main() {
            vec2 uv = clamp(vUV, 0.001, 0.999);
            vec4 col = texture2D(uTex, uv);
            if (uRightEye && uDepth > 0.0) {
                float convergenceOffset = 0.02;
                float lum = depthLum(uv);
                // local horizontal gradient -> ease shift at hard edges (halo suppression)
                float gL = luma(texture2D(uTex, vec2(clamp(uv.x - 2.0*uTexel, 0.001, 0.999), uv.y)).rgb);
                float gR = luma(texture2D(uTex, vec2(clamp(uv.x + 2.0*uTexel, 0.001, 0.999), uv.y)).rgb);
                float grad = abs(gR - gL);
                float edgeEase = 1.0 - smoothstep(0.10, 0.45, grad);
                float shift = (lum - 0.5) * uDepth * 0.3 + (convergenceOffset * uDepth);
                shift *= edgeEase;
                shift = clamp(shift, -0.06, 0.06);
                vec2 uv2 = clamp(vec2(uv.x + shift, uv.y), 0.001, 0.999);
                vec4 col2 = texture2D(uTex, uv2);
                // soft blend instead of a hard cutoff -> no seams along outlines
                float d = abs(lum - luma(col2.rgb));
                float w = 1.0 - smoothstep(0.12, 0.34, d);
                w = clamp(w * uIntensity, 0.0, 1.0);
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
        const vw = videoEl.videoWidth  || 1920;
        const vh = videoEl.videoHeight || 1080;
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

    let uMVP, uEyeShift, uDepthLoc, uRightEye, uTex, uTexelLoc, uIntensityLoc;
    function cacheUniforms() {
        uMVP      = gl.getUniformLocation(prog, 'uMVP');
        uEyeShift = gl.getUniformLocation(prog, 'uEyeShift');
        uDepthLoc = gl.getUniformLocation(prog, 'uDepth');
        uIntensityLoc = gl.getUniformLocation(prog, 'uIntensity');
        uTexelLoc = gl.getUniformLocation(prog, 'uTexel');
        uRightEye = gl.getUniformLocation(prog, 'uRightEye');
        uTex      = gl.getUniformLocation(prog, 'uTex');
    }

    // ----------------------------------------------------------------
    // Environment: sky gradient, trees, fireflies
    // ----------------------------------------------------------------

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
            // gentle bob
            vec3 p = aPos;
            p.y += sin(uTime * 0.7 + aPhase * 6.2831) * 0.08;
            p.x += cos(uTime * 0.5 + aPhase * 6.2831) * 0.05;

            // flicker brightness
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

    // Large sphere, dark green-black gradient (forest night sky)
    function buildSky() {
        const rings = 12, segs = 16, radius = 40;
        const verts = [];
        const indices = [];

        for (let r = 0; r <= rings; r++) {
            const theta = (r / rings) * Math.PI;
            // top (theta=0) lighter green-grey, bottom (theta=PI) near black
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

    // Simple dark tree silhouettes — cone (foliage) + cylinder (trunk),
    // scattered in a ring around the viewer at varying distances
    function buildTrees() {
        const verts = [];
        const indices = [];
        let vi = 0;

        const treeCount = 24;
        for (let i = 0; i < treeCount; i++) {
            const angle = (i / treeCount) * Math.PI * 2 + (Math.random()-0.5)*0.3;
            const dist  = 8 + Math.random() * 22;
            const cx = Math.sin(angle) * dist;
            const cz = -Math.cos(angle) * dist; // mostly in front/around
            const height = 4 + Math.random() * 5;
            const trunkR = 0.2 + Math.random() * 0.15;
            const foliageR = 0.8 + Math.random() * 1.2;

            // darker trees further away for depth fog effect
            const fog = Math.min(1, dist / 30);
            const col = [
                0.03 + 0.01*(1-fog),
                0.05 + 0.02*(1-fog),
                0.025 + 0.01*(1-fog)
            ];

            // trunk: simple quad (2 triangles) facing center-ish, billboard-like cross
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

            // foliage: simple cone made of triangle fan
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

    // Fireflies: scattered glowing points at various distances/heights
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
        // --- Sky ---
        gl.depthMask(false);
        gl.useProgram(envProg);
        const envAPos = gl.getAttribLocation(envProg, 'aPos');
        const envAColor = gl.getAttribLocation(envProg, 'aColor');
        const envMVP = gl.getUniformLocation(envProg, 'uMVP');

        gl.bindBuffer(gl.ARRAY_BUFFER, skyVertBuf);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyIndexBuf);
        const envStride = 24; // 6 floats
        gl.enableVertexAttribArray(envAPos);
        gl.vertexAttribPointer(envAPos, 3, gl.FLOAT, false, envStride, 0);
        gl.enableVertexAttribArray(envAColor);
        gl.vertexAttribPointer(envAColor, 3, gl.FLOAT, false, envStride, 12);
        gl.uniformMatrix4fv(envMVP, false, viewMVP);
        gl.drawElements(gl.TRIANGLES, skyIndexCount, gl.UNSIGNED_SHORT, 0);
        gl.depthMask(true);

        // --- Trees ---
        gl.bindBuffer(gl.ARRAY_BUFFER, treeVertBuf);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, treeIndexBuf);
        gl.enableVertexAttribArray(envAPos);
        gl.vertexAttribPointer(envAPos, 3, gl.FLOAT, false, envStride, 0);
        gl.enableVertexAttribArray(envAColor);
        gl.vertexAttribPointer(envAColor, 3, gl.FLOAT, false, envStride, 12);
        gl.uniformMatrix4fv(envMVP, false, viewMVP);
        gl.drawElements(gl.TRIANGLES, treeIndexCount, gl.UNSIGNED_SHORT, 0);

        // --- Fireflies ---
        gl.useProgram(fireflyProg);
        const ffAPos   = gl.getAttribLocation(fireflyProg, 'aPos');
        const ffAPhase = gl.getAttribLocation(fireflyProg, 'aPhase');
        const ffMVP    = gl.getUniformLocation(fireflyProg, 'uMVP');
        const ffTime   = gl.getUniformLocation(fireflyProg, 'uTime');

        gl.bindBuffer(gl.ARRAY_BUFFER, fireflyBuf);
        const ffStride = 16; // 4 floats
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

    // ----------------------------------------------------------------
    // Main frame loop
    // ----------------------------------------------------------------
    function onFrame(t, frame) {
        if (!xrSession) return;
        xrSession.requestAnimationFrame(onFrame);

        const pose = frame.getViewerPose(xrRefSpace);
        if (!pose) return;

        gl.bindFramebuffer(gl.FRAMEBUFFER, xrLayer.framebuffer);
        gl.clearColor(0,0,0,1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        if (videoEl.readyState >= 2) {
            gl.bindTexture(gl.TEXTURE_2D, videoTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl);
        }

        for (const view of pose.views) {
            const vp = xrLayer.getViewport(view);
            gl.viewport(vp.x, vp.y, vp.width, vp.height);

            const isRight  = view.eye === 'right';
            const eyeShift = isRight ? depth * 0.02 : -depth * 0.02;

            const viewMVP = mul4(view.projectionMatrix, view.transform.inverse.matrix);

            // Draw environment first (sky, trees, fireflies)
            drawEnvironment(viewMVP);

            // Draw the video screen on top
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
            gl.uniform1f(uIntensityLoc, intensity);
            gl.uniform1f(uTexelLoc, 1.0 / Math.max(320, videoEl.videoWidth || 1920));
            gl.uniform1f(uEyeShift, eyeShift);
            gl.uniform1i(uRightEye, isRight ? 1 : 0);
            gl.uniformMatrix4fv(uMVP, false, viewMVP);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    }

    waitForBody();
})();