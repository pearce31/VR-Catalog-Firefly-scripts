// ==UserScript==
// @name         WebXR SBS/OU/FullSBS 
// @namespace    http://tampermonkey.net/
// @version      8.4
// @description  WebXR with native SBS/OU/FullSBS merging + forest environment
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    let btn, modeBtn, recenterBtn;
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

    // == TUNING ==
    const PLANE_DISTANCE = 4.7;
    const PLANE_WIDTH    = 3.5;
    const VERT_SCALE_2D        = 1.11;
    const VERT_SCALE_HALF_SBS  = 1.11;
    const VERT_SCALE_OU        = 2.0;
    const VERT_SCALE_FULLSBS   = 2.0;
    // ============

    let currentMode = 0;
    const MODE_NAMES = ['2D', 'Half SBS', 'OU', 'Full SBS'];

    let startTime = 0;

    // ---------- waitForBody ----------
    function waitForBody() {
        if (document.body) setup();
        else setTimeout(waitForBody, 100);
    }

    // ---------- setup ----------
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

        modeBtn = document.createElement('button');
        modeBtn.textContent = 'Mode: 2D';
        modeBtn.style.cssText = `
            position:fixed; bottom:20px; right:160px; z-index:999999;
            padding:12px 20px; background:#555; color:white;
            border:none; border-radius:8px; font-size:16px; cursor:pointer; opacity:0.9;
        `;
        modeBtn.onclick = () => {
            currentMode = (currentMode + 1) % MODE_NAMES.length;
            modeBtn.textContent = 'Mode: ' + MODE_NAMES[currentMode];
            if (xrSession && gl) buildQuad();
        };
        document.body.appendChild(modeBtn);

        recenterBtn = document.createElement('button');
        recenterBtn.textContent = '⟳ Recenter';
        recenterBtn.style.cssText = `
            position:fixed; bottom:20px; right:300px; z-index:999999;
            padding:12px 20px; background:#0078d4; color:white;
            border:none; border-radius:8px; font-size:16px; cursor:pointer;
            opacity:0; pointer-events:none;
        `;
        recenterBtn.onclick = recenter;
        document.body.appendChild(recenterBtn);

        // ---- Mouse button controls ----
        window.addEventListener('mousedown', (e) => {
            if (e.button === 2) {            // RIGHT CLICK = enter/exit VR
                e.preventDefault();
                e.stopPropagation();
                toggleVR();
            }
        }, true);

        window.addEventListener('contextmenu', (e) => { e.preventDefault(); }, true);
        // ============================================================

        if (!navigator.xr) {
            btn.textContent = 'WebXR N/A';
            btn.style.background = '#888';
        }
    }

    // ---------- VR functions (unchanged) ----------
    function showVRControls() {
        recenterBtn.style.opacity = '0.9';
        recenterBtn.style.pointerEvents = 'auto';
    }

    function hideVRControls() {
        recenterBtn.style.opacity = '0';
        recenterBtn.style.pointerEvents = 'none';
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

        if (!navigator.xr) { alert('WebXR not supported.'); return; }
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
         fireflyProg, fireflyBuf]
            = Array(14).fill(null);
        fireflyCount = 0;
        btn.textContent = 'VR: OFF';
        hideVRControls();
    }

    // ----------------------------------------------------------------
    // Shaders, quad, texture, environment (unchanged)
    // ----------------------------------------------------------------
    const VS = `
        attribute vec3 aPos;
        attribute vec2 aUV;
        uniform mat4 uMVP;
        varying vec2 vUV;
        void main() {
            vUV = aUV;
            gl_Position = uMVP * vec4(aPos, 1.0);
        }
    `;

    const FS = `
        precision highp float;
        uniform sampler2D uTex;
        uniform int uMode;
        uniform int uEye;
        varying vec2 vUV;

        void main() {
            vec2 uv = vUV;
            if (uMode == 1) {
                uv.x = vUV.x * 0.5 + float(uEye) * 0.5;
            } else if (uMode == 2) {
                uv.y = vUV.y * 0.5 + float(uEye) * 0.5;
            } else if (uMode == 3) {
                uv.x = vUV.x * 0.5 + float(uEye) * 0.5;
            }
            uv = clamp(uv, 0.001, 0.999);
            vec4 col = texture2D(uTex, uv);
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
        if (!videoEl || !gl) return;
        let vw = videoEl.videoWidth || 1920;
        let vh = videoEl.videoHeight || 1080;
        let aspect;
        let vertScale = VERT_SCALE_2D;

        switch (currentMode) {
            case 0:
                aspect = vw / vh;
                vertScale = VERT_SCALE_2D;
                break;
            case 1:
                aspect = (vw / 2) / vh;
                vertScale = VERT_SCALE_HALF_SBS;
                break;
            case 2:
                aspect = vw / (vh / 2);
                vertScale = VERT_SCALE_OU;
                break;
            case 3:
                aspect = (vw / 2) / vh;
                vertScale = VERT_SCALE_FULLSBS;
                break;
            default:
                aspect = vw / vh;
                vertScale = VERT_SCALE_2D;
        }

        const hw = PLANE_WIDTH / 2;
        const hh = (hw / aspect) * vertScale;
        const z  = -PLANE_DISTANCE;

        if (quadBuf) gl.deleteBuffer(quadBuf);
        quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -hw,  hh, z,  0.0, 0.0,
             hw,  hh, z,  1.0, 0.0,
            -hw, -hh, z,  0.0, 1.0,
             hw, -hh, z,  1.0, 1.0,
        ]), gl.STATIC_DRAW);
        console.log(`Quad rebuilt for mode ${MODE_NAMES[currentMode]} (aspect ${aspect.toFixed(3)}, vertScale ${vertScale.toFixed(2)})`);
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

    let uMVP, uMode, uEye, uTex;
    function cacheUniforms() {
        uMVP  = gl.getUniformLocation(prog, 'uMVP');
        uMode = gl.getUniformLocation(prog, 'uMode');
        uEye  = gl.getUniformLocation(prog, 'uEye');
        uTex  = gl.getUniformLocation(prog, 'uTex');
    }

    // ----------------------------------------------------------------
    // Environment (sky, trees, fireflies) – unchanged
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
        const verts = [], indices = [];
        for (let r = 0; r <= rings; r++) {
            const theta = (r/rings)*Math.PI;
            const t = r/rings;
            const top=[0.05,0.10,0.07], bot=[0.01,0.01,0.015];
            const cr=top[0]+(bot[0]-top[0])*t;
            const cg=top[1]+(bot[1]-top[1])*t;
            const cb=top[2]+(bot[2]-top[2])*t;
            for (let s=0;s<=segs;s++) {
                const phi=(s/segs)*2*Math.PI;
                verts.push(
                    radius*Math.sin(theta)*Math.cos(phi),
                    radius*Math.cos(theta),
                    radius*Math.sin(theta)*Math.sin(phi),
                    cr,cg,cb
                );
            }
        }
        for (let r=0;r<rings;r++) {
            for (let s=0;s<segs;s++) {
                const a=r*(segs+1)+s, b=a+segs+1;
                indices.push(a,b,a+1, b,b+1,a+1);
            }
        }
        skyVertBuf=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,skyVertBuf);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
        skyIndexBuf=gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,skyIndexBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
        skyIndexCount=indices.length;
    }

    function buildTrees() {
        const verts=[],indices=[];
        let vi=0;
        for (let i=0;i<24;i++) {
            const angle=(i/24)*Math.PI*2+(Math.random()-0.5)*0.3;
            const dist=8+Math.random()*22;
            const cx=Math.sin(angle)*dist, cz=-Math.cos(angle)*dist;
            const height=4+Math.random()*5;
            const trunkR=0.2+Math.random()*0.15;
            const foliageR=0.8+Math.random()*1.2;
            const fog=Math.min(1,dist/30);
            const col=[0.03+0.01*(1-fog),0.05+0.02*(1-fog),0.025+0.01*(1-fog)];
            for (let s=0;s<5;s++) {
                const a0=(s/5)*Math.PI*2,a1=((s+1)/5)*Math.PI*2;
                const x0=cx+Math.cos(a0)*trunkR,z0=cz+Math.sin(a0)*trunkR;
                const x1=cx+Math.cos(a1)*trunkR,z1=cz+Math.sin(a1)*trunkR;
                verts.push(x0,0,z0,...col,x1,0,z1,...col,
                           x0,height*0.5,z0,...col,x1,height*0.5,z1,...col);
                indices.push(vi,vi+1,vi+2,vi+1,vi+3,vi+2);
                vi+=4;
            }
            const apex=vi;
            verts.push(cx,height,cz,col[0]*1.3,col[1]*1.4,col[2]*1.3);
            vi++;
            const bs=vi;
            for (let s=0;s<=8;s++) {
                const a=(s/8)*Math.PI*2;
                verts.push(cx+Math.cos(a)*foliageR,height*0.45,
                           cz+Math.sin(a)*foliageR,...col);
                vi++;
            }
            for (let s=0;s<8;s++) indices.push(apex,bs+s,bs+s+1);
        }
        treeVertBuf=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,treeVertBuf);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(verts),gl.STATIC_DRAW);
        treeIndexBuf=gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,treeIndexBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
        treeIndexCount=indices.length;
    }

    function buildFireflies() {
        fireflyCount=80;
        const data=[];
        for (let i=0;i<fireflyCount;i++) {
            const angle=Math.random()*Math.PI*2;
            const dist=2+Math.random()*15;
            data.push(Math.sin(angle)*dist,0.2+Math.random()*3.5,
                      -Math.cos(angle)*dist,Math.random());
        }
        fireflyBuf=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,fireflyBuf);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.STATIC_DRAW);
    }

    function drawEnvironment(viewMVP) {
        gl.depthMask(false);
        gl.useProgram(envProg);
        const envAPos=gl.getAttribLocation(envProg,'aPos');
        const envAColor=gl.getAttribLocation(envProg,'aColor');
        const envMVP=gl.getUniformLocation(envProg,'uMVP');
        const stride=24;

        gl.bindBuffer(gl.ARRAY_BUFFER,skyVertBuf);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,skyIndexBuf);
        gl.enableVertexAttribArray(envAPos);
        gl.vertexAttribPointer(envAPos,3,gl.FLOAT,false,stride,0);
        gl.enableVertexAttribArray(envAColor);
        gl.vertexAttribPointer(envAColor,3,gl.FLOAT,false,stride,12);
        gl.uniformMatrix4fv(envMVP,false,viewMVP);
        gl.drawElements(gl.TRIANGLES,skyIndexCount,gl.UNSIGNED_SHORT,0);
        gl.depthMask(true);

        gl.bindBuffer(gl.ARRAY_BUFFER,treeVertBuf);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,treeIndexBuf);
        gl.enableVertexAttribArray(envAPos);
        gl.vertexAttribPointer(envAPos,3,gl.FLOAT,false,stride,0);
        gl.enableVertexAttribArray(envAColor);
        gl.vertexAttribPointer(envAColor,3,gl.FLOAT,false,stride,12);
        gl.uniformMatrix4fv(envMVP,false,viewMVP);
        gl.drawElements(gl.TRIANGLES,treeIndexCount,gl.UNSIGNED_SHORT,0);

        gl.useProgram(fireflyProg);
        const ffAPos=gl.getAttribLocation(fireflyProg,'aPos');
        const ffAPhase=gl.getAttribLocation(fireflyProg,'aPhase');
        const ffMVP=gl.getUniformLocation(fireflyProg,'uMVP');
        const ffTime=gl.getUniformLocation(fireflyProg,'uTime');
        gl.bindBuffer(gl.ARRAY_BUFFER,fireflyBuf);
        gl.enableVertexAttribArray(ffAPos);
        gl.vertexAttribPointer(ffAPos,3,gl.FLOAT,false,16,0);
        gl.enableVertexAttribArray(ffAPhase);
        gl.vertexAttribPointer(ffAPhase,1,gl.FLOAT,false,16,12);
        gl.uniformMatrix4fv(ffMVP,false,viewMVP);
        gl.uniform1f(ffTime,(performance.now()-startTime)/1000.0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
        gl.depthMask(false);
        gl.drawArrays(gl.POINTS,0,fireflyCount);
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

            const isRight = view.eye === 'right';
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
            gl.uniform1i(uMode, currentMode);
            gl.uniform1i(uEye, isRight ? 1 : 0);
            gl.uniformMatrix4fv(uMVP, false, viewMVP);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    }

    waitForBody();
})();