#target photoshop
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
