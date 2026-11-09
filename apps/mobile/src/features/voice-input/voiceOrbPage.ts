export type VoiceOrbState = "dictating" | "processing" | "thinking" | "speaking";

/** The desktop orb's shader with only the driver a phone needs: state colours and audio level. */
export function voiceOrbPage(
  shaders: { readonly vertex: string; readonly fragment: string },
  state: VoiceOrbState,
): string {
  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}canvas{position:fixed;inset:0;width:100%;height:100%}</style>
</head><body><canvas id="orb"></canvas><script>
var LIVE={a:[.09,.18,.58],b:[.4,.56,1],c:[.94,.96,1],glow:1};
var BUSY={a:[.05,.1,.36],b:[.24,.36,.86],c:[.72,.8,1],glow:.75};
var PAL={dictating:LIVE,speaking:LIVE,processing:BUSY,thinking:BUSY};
var state=${JSON.stringify(state)},micLevel=0;
window.setOrb=function(next){state=next};
window.setOrbLevel=function(next){micLevel=next};
function Spring(v,k,d){this.x=v;this.v=0;this.t=v;this.k=k;this.d=d}
Spring.prototype.step=function(dt){var n=Math.max(1,Math.ceil(dt/.004)),h=dt/n;for(var i=0;i<n;i++){this.v+=(-this.k*(this.x-this.t)-this.d*this.v)*h;this.x+=this.v*h}return this.x};
var spr=function(v,k,d){return [new Spring(v[0],k,d),new Spring(v[1],k,d),new Spring(v[2],k,d)]};
var sA=spr(PAL[state].a,60,12),sB=spr(PAL[state].b,60,12),sC=spr(PAL[state].c,60,12);
var sLevel=new Spring(0,170,26),sScale=new Spring(1,120,19),sAppear=new Spring(0,190,15),sGlow=new Spring(.5,50,10),sBusy=new Spring(0,80,12),sPart=new Spring(.15,40,12);
var cv=document.getElementById("orb"),dpr=window.devicePixelRatio||1;
var gl=cv.getContext("webgl",{alpha:true,premultipliedAlpha:true,antialias:true});
function sh(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);return s}
var prog=gl.createProgram();
gl.attachShader(prog,sh(gl.VERTEX_SHADER,${JSON.stringify(shaders.vertex)}));
gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,${JSON.stringify(shaders.fragment)}));
gl.linkProgram(prog);gl.useProgram(prog);
gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
var a=gl.getAttribLocation(prog,"a");gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
var U=function(n){return gl.getUniformLocation(prog,n)};
gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
var lastT=performance.now(),flow=0,spin=0,audio=0,quad=[0,0,0,0];
var step3=function(s,t,dt){return s.map(function(x,i){x.t=t[i];return x.step(dt)})};
function frame(now){
  var dt=Math.min(.05,(now-lastT)/1000);lastT=now;
  var p=PAL[state],talking=state==="dictating"||state==="speaking",busy=state==="processing";
  var target=state==="dictating"?micLevel:state==="speaking"?.3+.45*Math.abs(Math.sin(now/95))*(.5+.5*Math.sin(now/700)):0;
  audio+=(target-audio)*(1-Math.exp(-dt*(target>audio?20:6)));
  sLevel.t=audio;sGlow.t=p.glow;sBusy.t=busy?1:0;sAppear.t=1;
  sScale.t=(1+.018*Math.sin(now/1700)+.006*Math.sin(now/730))*(1+.3*sLevel.x);
  sPart.t=talking?.55+.45*Math.min(1,sLevel.x*1.5):busy?.4:.18;
  var lvl=Math.max(0,sLevel.step(dt)),scale=sScale.step(dt),appear=sAppear.step(dt);
  var bands=talking?[lvl,lvl*.8,lvl*.6,lvl*.4]:[0,0,0,0];
  for(var k=0;k<4;k++){var g=Math.min(1,bands[k]*1.6);quad[k]+=(g-quad[k])*(1-Math.exp(-dt*(g>quad[k]?9:3.5)))}
  flow+=dt*((state==="thinking"?.85:.5)+2*lvl+(busy?.3:0));spin+=dt*.7;
  var w=cv.clientWidth*dpr,h=cv.clientHeight*dpr;
  if(cv.width!==w||cv.height!==h){cv.width=w;cv.height=h}
  gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(U("uRes"),w,h);gl.uniform2f(U("uCenter"),w/2,h/2);
  gl.uniform1f(U("uR"),Math.min(w,h)*.27*scale*(.35+.65*Math.max(0,appear)));
  gl.uniform1f(U("uAppear"),Math.max(0,Math.min(1,appear)));gl.uniform1f(U("uTime"),now/1000);
  gl.uniform1f(U("uThinking"),state==="thinking"?1:0);gl.uniform1f(U("uRipple"),0);gl.uniform1f(U("uTap"),0);gl.uniform1f(U("uPress"),0);
  gl.uniform2f(U("uTapWave"),0,0);gl.uniform1f(U("uApproval"),0);gl.uniform1f(U("uIdle"),0);gl.uniform1f(U("uContrast"),0);
  gl.uniform3f(U("uThread"),.3,.4,.5);gl.uniform1f(U("uLevel"),lvl);gl.uniform4f(U("uBands"),quad[0],quad[1],quad[2],quad[3]);
  gl.uniform1f(U("uFlow"),flow);gl.uniform1f(U("uParticles"),Math.max(0,sPart.step(dt)));gl.uniform1f(U("uGlow"),sGlow.step(dt));
  gl.uniform1f(U("uBusy"),state==="thinking"?0:sBusy.step(dt));gl.uniform1f(U("uSpin"),spin);gl.uniform1f(U("uArc"),1.4);gl.uniform1f(U("uOff"),0);
  gl.uniform3fv(U("uA"),step3(sA,p.a,dt));gl.uniform3fv(U("uB"),step3(sB,p.b,dt));gl.uniform3fv(U("uC"),step3(sC,p.c,dt));
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`;
}
