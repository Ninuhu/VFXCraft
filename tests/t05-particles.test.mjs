import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { validateProject } from "../src/core/document/validateDocument.ts";
import { createProject } from "../src/core/document/createProject.ts";
import { evaluateParticles2D, layerTransform } from "../src/core/particles/evaluate2D.ts";
import { EditingHistory } from "../src/core/editing/history.ts";
import { readVcr, writeVcr, REVIEW_VCR_LIMITS } from "../src/core/persistence/vcrArchive.ts";

const ID = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12,"0"); // 一意な検証ID

////////////////////
// 2D粒子の最小データを生成する
function fixture(patch = {}) {
    return validateProject({ ...createProject({id:ID(1),name:"T05",mode:"2d",drawing:"normal",canvasWidth:640,canvasHeight:360,durationUs:4e6}),
        layers:[{id:ID(2),name:"粒子",parentId:null,order:0,isVisible:true,isLocked:false,startUs:0,
            values:{position:[0,0],rotation:0,size:[1,1],color:[1,1,1],opacity:1}, content:{kind:"emitter",emitterId:ID(3)}}],
        emitters:[{id:ID(3),materialId:ID(4),lifetimeUs:1e6,emission:{kind:"continuous",ratePerSecond:10},
            particle2d:{speed:10,directionDegrees:0,acceleration:[0,20],space:"local",seed:7,shape:{kind:"point"},...patch}}],
        materials:[{id:ID(4),textureAssetId:null,blend:"alpha",color:[1,1,1],hasBloom:false,gradient:[]}] });
}
test("Continuousは時刻0に生成し、寿命の終端では消滅する",()=>{
    const doc=fixture(); // 連続発生データ
    assert.equal(evaluateParticles2D(doc,ID(2),0).length,1);
    assert.equal(evaluateParticles2D(doc,ID(2),99999).length,1);
    assert.equal(evaluateParticles2D(doc,ID(2),100000).length,2);
    assert.equal(evaluateParticles2D(doc,ID(2),1e6)[0].id,1);
});
test("Burstは時刻0で全数が現れ、寿命後に再発生しない",()=>{
    const doc=fixture(); // 一括に変更する候補
    const burst=validateProject({...doc,emitters:[{...doc.emitters[0],emission:{kind:"burst",count:20}}]}); // 検証した一括設定
    assert.equal(evaluateParticles2D(burst,ID(2),0).length,20);
    assert.equal(evaluateParticles2D(burst,ID(2),1e6).length,0);
    assert.equal(evaluateParticles2D(burst,ID(2),2e6).length,0);
});
test("初速・時計回り方向・一定加速度を秒で計算する",()=>{
    const doc=fixture({directionDegrees:90}); // 下向きの初速
    const p=evaluateParticles2D(doc,ID(2),500000)[0]; // 0.5秒の解析解
    assert.ok(Math.abs(p.position[0])<1e-12);
    assert.equal(p.position[1],7.5);
});
test("円は半径内、長方形は範囲内に発生し、シードと粒子番号で再現する",()=>{
    for(const shape of [{kind:"point"},{kind:"circle",radius:30},{kind:"rectangle",width:40,height:20}]){
        const doc=fixture({shape,speed:0,acceleration:[0,0]}); // 静止した形状サンプル
        const values=evaluateParticles2D(doc,ID(2),900000); // 生存粒子
        assert.deepEqual(evaluateParticles2D(doc,ID(2),900000),values);
        evaluateParticles2D(doc,ID(2),100000);
        assert.deepEqual(evaluateParticles2D(doc,ID(2),900000),values);
        for(const {position:[x,y]} of values){
            if(shape.kind==="circle") assert.ok(Math.hypot(x,y)<=30);
            else if(shape.kind==="rectangle") assert.ok(Math.abs(x)<=20 && Math.abs(y)<=10);
            else assert.deepEqual([x,y],[0,0]);
        }
    }
    assert.notDeepEqual(evaluateParticles2D(fixture({shape:{kind:"circle",radius:30}}),ID(2),9e5),
        evaluateParticles2D(fixture({shape:{kind:"circle",radius:30},seed:8}),ID(2),9e5));
});
test("ワールドは発生時、ローカルは現在の変換を使い、親の回転も合成する",()=>{
    const transform=(time)=>[1,0,0,1,time/1000,0]; // 右へ動く発生器
    const local=evaluateParticles2D(fixture({space:"local"}),ID(2),500000,transform)[0];
    const world=evaluateParticles2D(fixture({space:"world"}),ID(2),500000,transform)[0];
    assert.equal(local.position[0],505);
    assert.equal(world.position[0],5);
    const doc=fixture(); // 親付き文書
    const parent={...doc.layers[0],id:ID(5),content:{kind:"group"},values:{...doc.layers[0].values,position:[100,50],rotation:90}};
    const child={...doc.layers[0],parentId:ID(5),values:{...doc.layers[0].values,position:[10,0]}};
    const transformed=validateProject({...doc,layers:[parent,child]});
    const matrix=layerTransform(transformed,ID(2),0);
    assert.ok(Math.abs(matrix[4]-100)<1e-10);
    assert.ok(Math.abs(matrix[5]-60)<1e-10);
});
test("版1の固定ファイルを移行し、版2の設定を保存往復とUndo/Redoで維持する",async()=>{
    const verify=async()=>{}; // 画像デコードの実検証はT04のブラウザテストで実施
    const old=await readFile(new URL("./fixtures/vcr/t04-2d-v1.vcr",import.meta.url)); // 初版の互換性検体
    const migrated=await readVcr(new Blob([old]),REVIEW_VCR_LIMITS,verify);
    assert.equal(migrated.project.schemaVersion,6);
    assert.equal(migrated.project.pixelScale,2);
    const history=new EditingHistory(fixture()); // 現行文書
    const original=history.snapshot; // Undo先
    const settings={...original.project.emitters[0],particle2d:{...original.project.emitters[0].particle2d,speed:42,space:"world"}};
    history.execute({kind:"emitter.update",emitterId:ID(3),settings:{emission:settings.emission,lifetimeUs:settings.lifetimeUs,particle2d:settings.particle2d}});
    history.execute({kind:"drawing.update",drawing:"pixel",pixelScale:8});
    const file=await writeVcr({project:history.snapshot.project,images:new Map()},REVIEW_VCR_LIMITS,verify,"0.0.0");
    assert.deepEqual((await readVcr(file,REVIEW_VCR_LIMITS,verify)).project,history.snapshot.project);
    history.undo(); history.undo(); assert.equal(history.snapshot,original);
    history.redo(); assert.equal(history.snapshot.project.emitters[0].particle2d.speed,42);
});
test("不正な設定は文書と履歴を変更せず、大量粒子を有限数で評価する",()=>{
    const doc=fixture(); // 検証の基準文書
    const history=new EditingHistory(doc); // 編集対象
    const initial=history.snapshot; // 保護対象
    for(const patch of [{speed:NaN},{speed:-1},{directionDegrees:Infinity},{acceleration:[0,Infinity]},{seed:-1},
        {space:"other"},{shape:{kind:"circle",radius:-1}}]){
        assert.throws(()=>history.execute({kind:"emitter.update",emitterId:ID(3),settings:{
            emission:doc.emitters[0].emission,lifetimeUs:1e6,particle2d:{...doc.emitters[0].particle2d,...patch}}}));
        assert.equal(history.snapshot,initial);
    }
    assert.throws(()=>history.execute({kind:"drawing.update",drawing:"pixel",pixelScale:2.5}));
    const many=validateProject({...doc,emitters:[{...doc.emitters[0],emission:{kind:"burst",count:10000}}]}); // 大量生成
    assert.equal(evaluateParticles2D(many,ID(2),500000).length,10000);
});
