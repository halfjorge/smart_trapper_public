#!/usr/bin/env python3
# build_smart_trapper_bundle.py
#
# Creates a SmartTrapperB1/ bundle:
# - Photoshop JSX exporter: exports printed-shape masks + strict job.json
# - Rust engine: computes trap masks (B1 workflow)
# - Photoshop JSX importer: imports trap masks as TRAP__ layers
# - README + convenience scripts
# - Zips everything into SmartTrapperB1.zip
#
# Run:
#   python build_smart_trapper_bundle.py
#
# Then:
#   1) In Photoshop: File > Scripts > Browse... -> ps/export_printed_shapes.jsx
#   2) Build engine:  cd SmartTrapperB1/engine && cargo build --release
#   3) Run engine:   target\release\smart_trapper_b1.exe "C:\path\to\JOB_FOLDER" 5
#   4) In Photoshop: File > Scripts > Browse... -> ps/import_traps.jsx

from __future__ import annotations

import os
import sys
import json
import shutil
import zipfile
from pathlib import Path

BUNDLE_NAME = "SmartTrapperB1"
ZIP_NAME = f"{BUNDLE_NAME}.zip"

README_TXT = r"""SmartTrapper B1 (Hybrid export → external compute → reimport)

WHAT THIS DOES
1) Photoshop exports each separation as a mask PNG (white/transparent) + strict job.json metadata.
2) Rust engine computes traps:
   Trap(A over B) = (dilate(A, trapPx) ∩ B) − A
   If SOURCE A is MULTIPLY and KEY exists, trap also intersects KEY.
3) Photoshop imports computed trap masks back into the PSD as TRAP__A_over_B layers,
   inside the SOURCE group (COLOR__<A>), matching SOURCE blend/opacity/fillOpacity.

ASSUMPTIONS (same as your in-PSD script)
- Top layer is KEY (untouched)
- Bottom layer is PAPER (untouched)
- Color layers are visible ArtLayers between them

FOLDER STRUCTURE
ps/
  export_printed_shapes.jsx
  import_traps.jsx
engine/
  Cargo.toml
  src/main.rs

RUN STEPS
A) Photoshop export
   File > Scripts > Browse... -> ps/export_printed_shapes.jsx
   Choose an output folder, e.g. C:\temp\byrne_job
   It will create:
     masks/*.png
     job.json

B) Build + run Rust engine
   Open Command Prompt / PowerShell:

   cd SmartTrapperB1\engine
   cargo build --release

   Then run:
   target\release\smart_trapper_b1.exe "C:\temp\byrne_job" 5

   It will create:
     traps/*.png
     traps.json

C) Photoshop import
   File > Scripts > Browse... -> ps/import_traps.jsx
   Select the same job folder (contains job.json + traps.json)

NOTES
- Trap PNGs are white where trap exists, transparent elsewhere.
- Importer fills trap selections with SOURCE ink color and matches SOURCE appearance.
"""

EXPORT_JSX = r"""#target photoshop
app.bringToFront();

(function () {
  var LOG = [];
  function log(s){ LOG.push(String(s)); }

  function showLog(){
    var w = new Window("dialog", "EXPORT LOG");
    w.orientation = "column";
    w.alignChildren = ["fill","fill"];
    var t = w.add("edittext", undefined, LOG.join("\r\n"), {multiline:true, scrolling:true});
    t.preferredSize = [900,600];
    w.add("button", undefined, "OK", {name:"ok"});
    w.show();
  }

  function safeTrim(s){ return String(s).replace(/^\s+|\s+$/g, ""); }
  function sanitizeName(name){ return safeTrim(String(name).replace(/[\/\\:\*\?"<>\|]/g, "_")); }
  function cTID(s){ return charIDToTypeID(s); }
  function sTID(s){ return stringIDToTypeID(s); }

  function hasSelection(doc){
    try { doc.selection.bounds; return true; } catch(e){ return false; }
  }

  function selectTransparencyOfActiveLayer(){
    var idChnl = cTID("Chnl");
    var refSel = new ActionReference();
    refSel.putProperty(idChnl, cTID("fsel"));
    var refTrsp = new ActionReference();
    refTrsp.putEnumerated(idChnl, idChnl, cTID("Trsp"));
    var desc = new ActionDescriptor();
    desc.putReference(cTID("null"), refSel);
    desc.putReference(cTID("T   "), refTrsp);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function selectVectorMask(){
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(cTID("Chnl"), cTID("fsel"));
    desc.putReference(cTID("null"), ref);
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID("Path"), cTID("Ordn"), sTID("vectorMask"));
    desc.putReference(cTID("T   "), ref2);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function selectLayerMask(){
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(cTID("Chnl"), cTID("fsel"));
    desc.putReference(cTID("null"), ref);
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID("Chnl"), cTID("Chnl"), cTID("Msk "));
    desc.putReference(cTID("T   "), ref2);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function selectLayerShapeBestEffort(doc, label){
    doc.selection.deselect();
    try { selectTransparencyOfActiveLayer(); if(hasSelection(doc)){ log("  ["+label+"] selection=TRANSPARENCY"); return true; } } catch(e1){}
    try { doc.selection.deselect(); selectVectorMask(); if(hasSelection(doc)){ log("  ["+label+"] selection=VECTOR_MASK"); return true; } } catch(e2){}
    try { doc.selection.deselect(); selectLayerMask(); if(hasSelection(doc)){ log("  ["+label+"] selection=LAYER_MASK"); return true; } } catch(e3){}
    doc.selection.deselect();
    log("  ["+label+"] FAILED selection");
    return false;
  }

  // Write strict JSON reliably (ExtendScript JSON exists in modern PS; fallback included)
  function stringifyJSON(obj){
    try {
      if (typeof JSON !== "undefined" && JSON && JSON.stringify) {
        return JSON.stringify(obj, null, 2);
      }
    } catch(e){}
    // Minimal fallback (handles strings/numbers/bools/null/arrays/objects)
    function esc(s){
      return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/\t/g,"\\t");
    }
    function ser(x){
      if (x === null || x === undefined) return "null";
      var t = typeof x;
      if (t === "number") return isFinite(x) ? String(x) : "null";
      if (t === "boolean") return x ? "true" : "false";
      if (t === "string") return '"' + esc(x) + '"';
      if (x instanceof Array){
        var a = [];
        for (var i=0;i<x.length;i++) a.push(ser(x[i]));
        return "[" + a.join(",") + "]";
      }
      // object
      var parts = [];
      for (var k in x){
        if (!x.hasOwnProperty(k)) continue;
        parts.push('"' + esc(k) + '":' + ser(x[k]));
      }
      return "{" + parts.join(",") + "}";
    }
    return ser(obj);
  }

  function exportMaskPNGFromSelection(doc, outFile){
    // Make a temp doc and fill selection with white on transparent bg.
    var tmp = app.documents.add(doc.width, doc.height, doc.resolution, "TMP_MASK",
      NewDocumentMode.RGB, DocumentFill.BLACK);

    // Make background black, then we'll create alpha via transparency on saved PNG:
    // We'll paint white where selection is, then make non-selected transparent by using selection as alpha is messy.
    // Instead: Fill selection white, then convert black to transparent by using layer transparency:
    // We'll use a single layer: start with transparent doc using DocumentFill.TRANSPARENT if available.
    try {
      tmp.close(SaveOptions.DONOTSAVECHANGES);
      tmp = app.documents.add(doc.width, doc.height, doc.resolution, "TMP_MASK",
        NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
    } catch(e){}

    tmp.activeLayer = tmp.layers[0];
    app.foregroundColor = (function(){
      var c=new SolidColor(); c.rgb.red=255; c.rgb.green=255; c.rgb.blue=255; return c;
    })();

    // Paste selection via channel store/load trick: store selection into doc channel, duplicate doc channel to tmp is hard.
    // So simplest: copy selection pixels from a filled layer in original doc? Not safe.
    // Better approach: we already have selection in original doc; just create same selection bounds in tmp by copying selection to clipboard:
    // Photoshop can copy selection as pixels only, not as selection. We'll do a pragmatic approach:
    // Create a 1px selection and expand? No.
    //
    // Practical workaround that works reliably:
    // - In original doc, fill selection into a temporary solid layer, copy merged, paste into tmp, delete temp.
    var host = doc;
    var oldActive = host.activeLayer;
    var tempFill = host.artLayers.add();
    tempFill.name = "__TMP_EXPORT_FILL__";
    tempFill.blendMode = BlendMode.NORMAL;
    tempFill.opacity = 100;
    host.activeLayer = tempFill;
    try {
      host.selection.fill(app.foregroundColor, ColorBlendMode.NORMAL, 100, false);
    } catch(eFill){
      try { tempFill.remove(); } catch(e){}
      try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
      host.activeLayer = oldActive;
      throw eFill;
    }

    host.selection.copy(); // copies selection pixels of tempFill
    app.activeDocument = tmp;
    tmp.paste();
    // The pasted layer has transparency where selection wasn't
    // Flatten for a simple PNG
    try { tmp.flatten(); } catch(e){}

    var opts = new PNGSaveOptions();
    tmp.saveAs(outFile, opts, true, Extension.LOWERCASE);

    // Cleanup
    try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
    app.activeDocument = host;
    try { tempFill.remove(); } catch(e){}
    host.activeLayer = oldActive;
  }

  // MAIN
  var prevDialogs = app.displayDialogs;
  try {
    app.displayDialogs = DialogModes.NO;

    if(!documents.length){
      alert("Open a PSD first.");
      return;
    }
    var doc = app.activeDocument;

    var outFolder = Folder.selectDialog("Choose output folder for masks + job.json");
    if(!outFolder) return;

    var masksFolder = new Folder(outFolder.fsName + "/masks");
    if(!masksFolder.exists) masksFolder.create();

    if(doc.layers.length < 3){
      alert("Need at least 3 top-level layers (KEY top, PAPER bottom, colors between).");
      return;
    }

    var keyLayer = doc.layers[0];
    var paperLayer = doc.layers[doc.layers.length-1];

    var colorsBottomToTop = [];
    for(var i = doc.layers.length - 2; i >= 1; i--){
      var L = doc.layers[i];
      if(!L.visible) continue;
      if(L.typename !== "ArtLayer") continue;
      colorsBottomToTop.push(L);
    }

    log("Document: " + doc.name);
    log("Key: " + keyLayer.name);
    log("Paper: " + paperLayer.name);
    log("Colors: " + colorsBottomToTop.length);

    // Build job object (strict JSON)
    var job = {
      docName: doc.name,
      widthPx: Math.round(doc.width.as("px")),
      heightPx: Math.round(doc.height.as("px")),
      resolution: doc.resolution,
      keyLayerName: keyLayer.name,
      paperLayerName: paperLayer.name,
      // bottom->top
      colors: [],
      files: []
    };

    function addLayer(kind, layer){
      var bm = "UNKNOWN", op = 100, fop = 100;
      try { bm = String(layer.blendMode); } catch(e){}
      try { op = layer.opacity; } catch(e){}
      try { fop = layer.fillOpacity; } catch(e){}

      // make selection for this layer
      var old = doc.activeLayer;
      doc.activeLayer = layer;
      doc.selection.deselect();
      var okSel = selectLayerShapeBestEffort(doc, kind + "=" + layer.name);
      if(!okSel || !hasSelection(doc)){
        log(kind + " SKIP export (no selection): " + layer.name);
        doc.selection.deselect();
        doc.activeLayer = old;
        return;
      }

      var fname = (kind==="KEY" ? "KEY__" : "COLOR__") + sanitizeName(layer.name) + ".png";
      var outFile = new File(masksFolder.fsName + "/" + fname);

      exportMaskPNGFromSelection(doc, outFile);

      // clear selection
      doc.selection.deselect();
      doc.activeLayer = old;

      job.files.push({
        kind: kind,
        name: layer.name,
        blendMode: bm,
        opacity: op,
        fillOpacity: fop,
        png: "masks/" + fname
      });

      if(kind==="COLOR"){
        job.colors.push({
          name: layer.name,
          blendMode: bm,
          opacity: op,
          fillOpacity: fop
        });
      }

      log(kind + " export OK: " + layer.name + " -> " + fname);
    }

    // Export KEY then colors
    addLayer("KEY", keyLayer);
    for(var c=0;c<colorsBottomToTop.length;c++){
      addLayer("COLOR", colorsBottomToTop[c]);
    }

    // Write job.json (strict JSON)
    var jobFile = new File(outFolder.fsName + "/job.json");
    jobFile.open("w");
    jobFile.encoding = "UTF8";
    jobFile.write(stringifyJSON(job));
    jobFile.close();

    alert("Export done.\n\nWrote masks/ + job.json to:\n" + outFolder.fsName);
    showLog();

  } catch(e){
    log("FATAL: " + e);
    try { showLog(); } catch(e2){}
    alert("Export failed. See log.");
  } finally {
    try { app.displayDialogs = prevDialogs; } catch(e3){}
  }
})();
"""

IMPORT_JSX = r"""#target photoshop
app.bringToFront();

(function () {
  var LOG = [];
  function log(s){ LOG.push(String(s)); }

  function showLog(){
    var w = new Window("dialog", "IMPORT LOG");
    w.orientation = "column";
    w.alignChildren = ["fill","fill"];
    var t = w.add("edittext", undefined, LOG.join("\r\n"), {multiline:true, scrolling:true});
    t.preferredSize = [900,600];
    w.add("button", undefined, "OK", {name:"ok"});
    w.show();
  }

  function safeTrim(s){ return String(s).replace(/^\s+|\s+$/g, ""); }
  function sanitizeName(name){ return safeTrim(String(name).replace(/[\/\\:\*\?"<>\|]/g, "_")); }
  function cTID(s){ return charIDToTypeID(s); }

  function hasSelection(doc){
    try { doc.selection.bounds; return true; } catch(e){ return false; }
  }

  function selectTransparencyOfActiveLayer(){
    var idChnl = cTID("Chnl");
    var refSel = new ActionReference();
    refSel.putProperty(idChnl, cTID("fsel"));
    var refTrsp = new ActionReference();
    refTrsp.putEnumerated(idChnl, idChnl, cTID("Trsp"));
    var desc = new ActionDescriptor();
    desc.putReference(cTID("null"), refSel);
    desc.putReference(cTID("T   "), refTrsp);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function findColorGroup(doc, sourceLayerName){
    var want = "COLOR__" + sanitizeName(sourceLayerName);
    for(var i=0;i<doc.layerSets.length;i++){
      if(doc.layerSets[i].name === want) return doc.layerSets[i];
    }
    return null;
  }

  function findBaseArtLayerInGroup(group){
    for(var i=0;i<group.layers.length;i++){
      if(group.layers[i].typename === "ArtLayer") return group.layers[i];
    }
    return null;
  }

  function createTrapLayerInSourceGroup(doc, sourceGroup, sourceBaseLayer, trapName){
    var newL = doc.artLayers.add();
    newL.name = trapName;
    newL.move(sourceGroup, ElementPlacement.INSIDE);
    try { newL.move(sourceBaseLayer, ElementPlacement.PLACEBEFORE); } catch(e){}
    return newL;
  }

  function applySourceAppearanceToTrap(trapLayer, sourceLayer){
    try { trapLayer.blendMode = sourceLayer.blendMode; } catch(e){}
    try { trapLayer.opacity = sourceLayer.opacity; } catch(e){}
    try { trapLayer.fillOpacity = sourceLayer.fillOpacity; } catch(e){}
    try { trapLayer.visible = sourceLayer.visible; } catch(e){}
  }

  function readJsonFile(path){
    var f = new File(path);
    if(!f.exists) throw new Error("Missing file: " + path);
    f.open("r");
    f.encoding = "UTF8";
    var txt = f.read();
    f.close();
    if(typeof JSON === "undefined" || !JSON || !JSON.parse){
      throw new Error("JSON.parse not available in this Photoshop.");
    }
    return JSON.parse(txt);
  }

  function openPngAndLoadSelection(pngFile){
    var d = app.open(pngFile);
    d.activeLayer = d.layers[0];
    d.selection.deselect();
    try { selectTransparencyOfActiveLayer(); } catch(e){}
    return { doc:d, ok: hasSelection(d) };
  }

  function sampleOnePixelColorFromLayer(doc, layer){
    var oldActive = doc.activeLayer;
    doc.activeLayer = layer;

    doc.selection.deselect();
    try { selectTransparencyOfActiveLayer(); } catch(e){}
    if(!hasSelection(doc)){
      doc.activeLayer = oldActive;
      throw new Error("Cannot sample color, no transparency selection: " + layer.name);
    }
    var b = doc.selection.bounds;
    var x = Math.floor(b[0].as("px")) + 2;
    var y = Math.floor(b[1].as("px")) + 2;

    var sampler = doc.colorSamplers.add([x,y]);
    var c = sampler.color;
    sampler.remove();
    doc.selection.deselect();

    doc.activeLayer = oldActive;
    return c;
  }

  // MAIN
  var prevDialogs = app.displayDialogs;
  try {
    app.displayDialogs = DialogModes.NO;

    if(!documents.length){
      alert("Open the PSD you exported from first.");
      return;
    }
    var hostDoc = app.activeDocument;

    var folder = Folder.selectDialog("Select the JOB folder (contains job.json and traps.json)");
    if(!folder) return;

    var job = readJsonFile(folder.fsName + "/job.json");
    var traps = readJsonFile(folder.fsName + "/traps.json");

    log("Importing into: " + hostDoc.name);
    log("Traps count: " + traps.traps.length);

    var imported = 0;

    for(var i=0;i<traps.traps.length;i++){
      var t = traps.traps[i]; // {source, target, png}

      var sourceGroup = findColorGroup(hostDoc, t.source);
      if(!sourceGroup){
        log("SKIP: missing source group for " + t.source);
        continue;
      }
      var sourceBase = findBaseArtLayerInGroup(sourceGroup);
      if(!sourceBase){
        log("SKIP: no base ArtLayer in group for " + t.source);
        continue;
      }

      var png = new File(folder.fsName + "/" + t.png);
      if(!png.exists){
        log("SKIP: missing trap png: " + png.fsName);
        continue;
      }

      var opened = openPngAndLoadSelection(png);
      if(!opened.ok){
        try { opened.doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
        log("SKIP: empty trap selection: " + t.png);
        continue;
      }

      opened.doc.selection.copy();
      app.activeDocument = hostDoc;

      hostDoc.paste();
      var pasted = hostDoc.activeLayer;
      pasted.name = "__TMP_TRAP_PASTE__";

      hostDoc.selection.deselect();
      try { selectTransparencyOfActiveLayer(); } catch(e){}
      if(!hasSelection(hostDoc)){
        try { pasted.remove(); } catch(e){}
        try { opened.doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
        log("SKIP: failed to load selection from pasted trap: " + t.png);
        continue;
      }
      try { pasted.remove(); } catch(e){}
      try { opened.doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}

      var trapName = "TRAP__" + sanitizeName(t.source) + "_over_" + sanitizeName(t.target);
      var trapLayer = createTrapLayerInSourceGroup(hostDoc, sourceGroup, sourceBase, trapName);

      applySourceAppearanceToTrap(trapLayer, sourceBase);
      hostDoc.activeLayer = trapLayer;

      var ink = sampleOnePixelColorFromLayer(hostDoc, sourceBase);
      app.foregroundColor = ink;

      hostDoc.selection.fill(app.foregroundColor, ColorBlendMode.NORMAL, 100, false);
      hostDoc.selection.deselect();

      imported++;
      log("IMPORTED: " + trapName);
    }

    alert("Import done.\nImported trap layers: " + imported);
    showLog();

  } catch(eTop){
    log("FATAL: " + eTop);
    try { showLog(); } catch(e2){}
    alert("Import failed. See log.");
  } finally {
    try { app.displayDialogs = prevDialogs; } catch(e3){}
  }
})();
"""

CARGO_TOML = r"""[package]
name = "smart_trapper_b1"
version = "0.1.0"
edition = "2021"

[dependencies]
image = "0.25"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
anyhow = "1.0"
"""

RUST_MAIN = r"""use anyhow::{Context, Result};
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
struct JobFile {
    docName: String,
    widthPx: u32,
    heightPx: u32,
    resolution: f64,
    keyLayerName: String,
    paperLayerName: String,
    colors: Vec<ColorMeta>, // bottom->top
    files: Vec<FileMeta>,   // includes KEY + COLOR entries
}

#[derive(Debug, Deserialize)]
struct ColorMeta {
    name: String,
    blendMode: String,
    opacity: f64,
    fillOpacity: f64,
}

#[derive(Debug, Deserialize, Clone)]
struct FileMeta {
    kind: String,     // "KEY" or "COLOR"
    name: String,
    blendMode: String,
    opacity: f64,
    fillOpacity: f64,
    png: String,      // relative path "masks/..png"
}

#[derive(Debug, Serialize)]
struct TrapSpec {
    source: String,
    target: String,
    png: String,      // relative "traps/..png"
}

#[derive(Debug, Serialize)]
struct TrapsOut {
    traps: Vec<TrapSpec>,
}

fn sanitize(s: &str) -> String {
    s.trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect()
}

fn read_mask_rgba(path: &Path) -> Result<(u32, u32, Vec<u8>)> {
    let img = image::open(path)
        .with_context(|| format!("open png: {}", path.display()))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    Ok((w, h, img.into_raw()))
}

fn alpha_to_bit(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; (w * h) as usize];
    for i in 0..(w * h) as usize {
        let a = rgba[i * 4 + 3];
        out[i] = if a > 0 { 1 } else { 0 };
    }
    out
}

fn dilate_square(src: &[u8], w: u32, h: u32, r: i32) -> Vec<u8> {
    if r <= 0 {
        return src.to_vec();
    }
    let mut out = vec![0u8; (w * h) as usize];
    let w_i = w as i32;
    let h_i = h as i32;

    for y in 0..h_i {
        for x in 0..w_i {
            let mut on = 0u8;
            'neigh: for yy in (y - r)..=(y + r) {
                if yy < 0 || yy >= h_i { continue; }
                for xx in (x - r)..=(x + r) {
                    if xx < 0 || xx >= w_i { continue; }
                    let idx = (yy as u32 * w + xx as u32) as usize;
                    if src[idx] != 0 {
                        on = 1;
                        break 'neigh;
                    }
                }
            }
            out[(y as u32 * w + x as u32) as usize] = on;
        }
    }
    out
}

fn and(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter()
        .zip(b.iter())
        .map(|(&x, &y)| if x != 0 && y != 0 { 1 } else { 0 })
        .collect()
}

fn and_not(a: &[u8], b: &[u8]) -> Vec<u8> {
    // a & !b
    a.iter()
        .zip(b.iter())
        .map(|(&x, &y)| if x != 0 && y == 0 { 1 } else { 0 })
        .collect()
}

fn write_trap_png(path: &Path, w: u32, h: u32, mask: &[u8]) -> Result<()> {
    let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let idx = (y * w + x) as usize;
            let a = if mask[idx] != 0 { 255u8 } else { 0u8 };
            img.put_pixel(x, y, Rgba([255, 255, 255, a]));
        }
    }
    img.save(path)
        .with_context(|| format!("save png: {}", path.display()))?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: smart_trapper_b1 <JOB_FOLDER> [trapPx]");
        eprintln!(r#"Example: smart_trapper_b1 "C:\temp\byrne_job" 5"#);
        std::process::exit(2);
    }
    let job_folder = PathBuf::from(&args[1]);
    let trap_px: i32 = if args.len() >= 3 { args[2].parse().unwrap_or(5) } else { 5 };

    let job_path = job_folder.join("job.json");
    let job_txt = fs::read_to_string(&job_path)
        .with_context(|| format!("read job.json: {}", job_path.display()))?;
    let job: JobFile = serde_json::from_str(&job_txt)
        .with_context(|| "parse job.json (must be strict JSON)")?;

    // Map layer name -> file meta
    let mut file_map: HashMap<String, FileMeta> = HashMap::new();
    for f in &job.files {
        file_map.insert(f.name.clone(), f.clone());
    }

    // Load KEY mask if present
    let mut key_mask: Option<Vec<u8>> = None;
    for f in &job.files {
        if f.kind == "KEY" {
            let p = job_folder.join(&f.png);
            let (w, h, rgba) = read_mask_rgba(&p)?;
            if w != job.widthPx || h != job.heightPx {
                anyhow::bail!("KEY mask size mismatch ({}x{} vs {}x{})", w, h, job.widthPx, job.heightPx);
            }
            key_mask = Some(alpha_to_bit(w, h, &rgba));
        }
    }

    let traps_dir = job_folder.join("traps");
    if !traps_dir.exists() {
        fs::create_dir_all(&traps_dir)?;
    }

    let color_names: Vec<String> = job.colors.iter().map(|c| c.name.clone()).collect();
    let mut out = TrapsOut { traps: vec![] };

    for (ai, a_name) in color_names.iter().enumerate() {
        let a_file = file_map.get(a_name).context("missing A file meta")?;
        let a_path = job_folder.join(&a_file.png);
        let (w, h, rgba_a) = read_mask_rgba(&a_path)?;
        if w != job.widthPx || h != job.heightPx {
            anyhow::bail!("A mask size mismatch for {}", a_name);
        }
        let a = alpha_to_bit(w, h, &rgba_a);

        let a_is_multiply = a_file.blendMode.contains("MULTIPLY");
        let da = dilate_square(&a, w, h, trap_px);

        for bi in (ai + 1)..color_names.len() {
            let b_name = &color_names[bi];
            let b_file = file_map.get(b_name).context("missing B file meta")?;
            let b_path = job_folder.join(&b_file.png);
            let (wb, hb, rgba_b) = read_mask_rgba(&b_path)?;
            if wb != job.widthPx || hb != job.heightPx {
                anyhow::bail!("B mask size mismatch for {}", b_name);
            }
            let b = alpha_to_bit(w, h, &rgba_b);

            // Trap(A over B) = (dilate(A) & B) & !A
            let cand = and(&da, &b);
            let mut trap = and_not(&cand, &a);

            // Multiply-source guard: trap &= KEY if available
            if a_is_multiply {
                if let Some(k) = &key_mask {
                    trap = and(&trap, k);
                }
            }

            if !trap.iter().any(|&v| v != 0) {
                continue;
            }

            let out_name = format!(
                "TRAP__{}_over_{}.png",
                sanitize(a_name),
                sanitize(b_name)
            );
            let out_rel = format!("traps/{}", out_name);
            let out_path = traps_dir.join(&out_name);
            write_trap_png(&out_path, w, h, &trap)?;

            out.traps.push(TrapSpec {
                source: a_name.clone(),
                target: b_name.clone(),
                png: out_rel,
            });
        }

        // Optional: trap to KEY
        if let Some(k) = &key_mask {
            let cand = and(&da, k);
            let mut trap = and_not(&cand, &a);
            if a_is_multiply {
                trap = and(&trap, k);
            }
            if trap.iter().any(|&v| v != 0) {
                let out_name = format!("TRAP__{}_over_KEY.png", sanitize(a_name));
                let out_rel = format!("traps/{}", out_name);
                let out_path = traps_dir.join(&out_name);
                write_trap_png(&out_path, w, h, &trap)?;
                out.traps.push(TrapSpec {
                    source: a_name.clone(),
                    target: "KEY".to_string(),
                    png: out_rel,
                });
            }
        }
    }

    let traps_json = serde_json::to_string_pretty(&out)?;
    fs::write(job_folder.join("traps.json"), traps_json)?;

    println!("Done. Wrote traps.json + traps/*.png");
    Ok(())
}
"""

RUN_ENGINE_BAT = r"""@echo off
REM Run from SmartTrapperB1\engine\
REM Usage:
REM   run_engine.bat "C:\path\to\JOB_FOLDER" 5
set JOB=%~1
set PX=%~2
if "%JOB%"=="" (
  echo Usage: run_engine.bat "C:\path\to\JOB_FOLDER" 5
  exit /b 1
)
if "%PX%"=="" set PX=5
target\release\smart_trapper_b1.exe "%JOB%" %PX%
"""

def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")

def zip_dir(src_dir: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for p in src_dir.rglob("*"):
            if p.is_file():
                z.write(p, arcname=str(p.relative_to(src_dir)))

def main() -> int:
    root = Path.cwd()
    bundle_dir = root / BUNDLE_NAME
    zip_path = root / ZIP_NAME

    # clean old
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    if zip_path.exists():
        zip_path.unlink()

    # write files
    write_text(bundle_dir / "README.txt", README_TXT)
    write_text(bundle_dir / "ps" / "export_printed_shapes.jsx", EXPORT_JSX)
    write_text(bundle_dir / "ps" / "import_traps.jsx", IMPORT_JSX)
    write_text(bundle_dir / "engine" / "Cargo.toml", CARGO_TOML)
    write_text(bundle_dir / "engine" / "src" / "main.rs", RUST_MAIN)
    write_text(bundle_dir / "engine" / "run_engine.bat", RUN_ENGINE_BAT)

    # zip
    zip_dir(bundle_dir, zip_path)

    print(f"Built folder: {bundle_dir}")
    print(f"Built zip:    {zip_path}")
    print("\nNext:")
    print(f"  cd {BUNDLE_NAME}\\engine")
    print("  cargo build --release")
    print(r'  target\release\smart_trapper_b1.exe "C:\path\to\JOB_FOLDER" 5')
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

