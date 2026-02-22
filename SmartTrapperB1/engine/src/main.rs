use anyhow::{Context, Result};
use clap::Parser;
use image::{ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

fn default_tolerance() -> u32 { 5 }

#[derive(Parser, Debug)]
#[command(name="smart_trapper_b1", about="Phase 2 trapper (spread-only + paper island removal)")]
struct Args {
    job_folder: String,
    trap_px: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct JobFile {
    docName: String,
    widthPx: u32,
    heightPx: u32,
    resolution: f64,

    #[serde(default="default_tolerance")]
    tolerance: u32,

    keyLayerName: String,
    paperLayerName: String,

    colors: Vec<ColorMeta>,
    files: Vec<FileMeta>,
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
    kind: String,
    name: String,
    blendMode: String,
    opacity: f64,
    fillOpacity: f64,
    png: String,
}

#[derive(Debug, Serialize)]
struct TrapSpec {
    source: String,
    target: String,
    png: String,
}

#[derive(Debug, Serialize)]
struct TrapsOut {
    traps: Vec<TrapSpec>,
}

fn sanitize(s:&str)->String{
    s.chars().map(|c| if "/\\:*?\"<>|".contains(c){'_' } else {c}).collect()
}

fn read_mask_rgba(path:&Path)->Result<(u32,u32,Vec<u8>)>{
    let img=image::open(path)?.to_rgba8();
    let (w,h)=img.dimensions();
    Ok((w,h,img.into_raw()))
}

fn alpha_to_bit(w:u32,h:u32,rgba:&[u8])->Vec<u8>{
    let mut out=vec![0u8;(w*h)as usize];
    for i in 0..(w*h)as usize{
        out[i]=if rgba[i*4+3]>0{1}else{0};
    }
    out
}

fn any_on(m:&[u8])->bool{ m.iter().any(|&v|v!=0) }

fn dirs8()->[(i32,i32);8]{
    [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]
}

fn edt(mask:&[u8],w:u32,h:u32)->Vec<f32>{
    let n=(w*h)as usize;
    let mut dist=vec![1e9f32;n];
    let mut q=VecDeque::new();

    for i in 0..n{
        if mask[i]!=0{ dist[i]=0.0; q.push_back(i); }
    }

    while let Some(idx)=q.pop_front(){
        let x=(idx as u32%w)as i32;
        let y=(idx as u32/w)as i32;

        for (dx,dy) in [(1,0),(-1,0),(0,1),(0,-1)]{
            let nx=x+dx;
            let ny=y+dy;
            if nx<0||ny<0||nx>=w as i32||ny>=h as i32{continue;}
            let nidx=(ny as u32*w+nx as u32)as usize;
            if dist[nidx]>dist[idx]+1.0{
                dist[nidx]=dist[idx]+1.0;
                q.push_back(nidx);
            }
        }
    }
    dist
}

fn main()->Result<()>{
    let args=Args::parse();

    let job_folder=PathBuf::from(&args.job_folder);
    let job:JobFile=serde_json::from_str(
        &fs::read_to_string(job_folder.join("job.json"))?
    )?;

    let w=job.widthPx;
    let h=job.heightPx;
    let n=(w*h)as usize;

    let trap_px=args.trap_px.unwrap_or(job.tolerance as i32).max(0);

    // Load plates
    let mut plate_names=Vec::new();
    let mut plates=Vec::new();

    for c in &job.colors{
        let f=job.files.iter().find(|f|f.name==c.name).unwrap();
        let (mw,mh,rgba)=read_mask_rgba(&job_folder.join(&f.png))?;
        if mw!=w||mh!=h{ anyhow::bail!("mask size mismatch"); }
        plate_names.push(c.name.clone());
        plates.push(alpha_to_bit(w,h,&rgba));
    }

    // Detect touching boundaries
    let mut pair_boundary:HashMap<(usize,usize),Vec<u8>>=HashMap::new();
    let neigh=dirs8();

    for y in 0..h as i32{
        for x in 0..w as i32{
            let idx=(y as u32*w+x as u32)as usize;

            for (dx,dy) in neigh{
                let nx=x+dx;
                let ny=y+dy;
                if nx<0||ny<0||nx>=w as i32||ny>=h as i32{continue;}
                let nidx=(ny as u32*w+nx as u32)as usize;

                for a in 0..plates.len(){
                    if plates[a][idx]==0{continue;}
                    for b in 0..plates.len(){
                        if a==b{continue;}
                        if plates[b][nidx]==0{continue;}

                        let lower=a.min(b);
                        let upper=a.max(b);
                        pair_boundary.entry((lower,upper))
                            .or_insert_with(||vec![0u8;n])[idx]=1;
                    }
                }
            }
        }
    }

    let traps_dir=job_folder.join("traps");
    if traps_dir.exists(){ fs::remove_dir_all(&traps_dir)?; }
    fs::create_dir_all(&traps_dir)?;

    let mut out=TrapsOut{traps:vec![]};

    for ((lower,upper),_) in pair_boundary{
        let dist=edt(&plates[lower],w,h);
        let mut trap_mask=vec![0u8;n];

        for i in 0..n{
            if plates[upper][i]!=0 && dist[i]<=trap_px as f32{
                trap_mask[i]=1;
            }
        }

        if !any_on(&trap_mask){continue;}

        let src=plate_names[lower].clone();
        let tgt=plate_names[upper].clone();

        let file_name=format!("TRAP__{}_over_{}.png",sanitize(&src),sanitize(&tgt));
        let out_path=traps_dir.join(&file_name);

        let mut img=ImageBuffer::<Rgba<u8>,Vec<u8>>::new(w,h);
        for y in 0..h{
            for x in 0..w{
                let idx=(y*w+x)as usize;
                let a=if trap_mask[idx]!=0{255}else{0};
                img.put_pixel(x,y,Rgba([255,255,255,a]));
            }
        }
        img.save(&out_path)?;

        out.traps.push(TrapSpec{
            source:src,
            target:tgt,
            png:format!("traps/{}",file_name),
        });
    }

    fs::write(
        job_folder.join("traps.json"),
        serde_json::to_string_pretty(&out)?,
    )?;

    Ok(())
}