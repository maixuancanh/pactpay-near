import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import ocrWorker from "tesseract.js/dist/worker.min.js?url";

export async function readEvidenceFile(file: File) {
  if (file.size > 8_000_000) throw new Error("Choose a file smaller than 8 MB.");
  if (/\.(txt|md)$/i.test(file.name)) return file.text();
  async function recognize(image: File | HTMLCanvasElement) {
    const {createWorker} = await import("tesseract.js");
    const worker = await createWorker("eng+vie", 1, {workerPath:ocrWorker});
    try {return (await worker.recognize(image)).data.text;}
    finally {await worker.terminate();}
  }
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) return recognize(file);
  if (!/\.pdf$/i.test(file.name)) throw new Error("Choose PDF, PNG, JPEG, WebP or a text file.");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
  const doc=await pdfjs.getDocument({data:await file.arrayBuffer(),isEvalSupported:false,enableXfa:false}).promise;
  try {
    if(doc.numPages>10)throw new Error("Select a PDF with up to 10 pages.");
    const result=[];
    for(let i=1;i<=doc.numPages;i++){
      const page=await doc.getPage(i);
      const content=await page.getTextContent();
      let text=content.items.map(item=>"str" in item?item.str:"").join(" ").trim();
      if(!text){
        const base=page.getViewport({scale:1});
        const viewport=page.getViewport({scale:Math.min(2,1800/Math.max(base.width,base.height))});
        const canvas=document.createElement("canvas");
        canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        await page.render({canvas,viewport}).promise;
        text=await recognize(canvas);
      }
      result.push("Page "+i+"\n"+text);
    }
    return result.join("\n\n");
  }finally{await doc.destroy();}
}

export function redactEvidence(text:string, terms:string) {
  let result=text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[email removed]")
    .replace(/(?<!\w)\+?\d(?:[ .()-]*\d){7,14}(?!\w)/g,"[number removed]");
  for(const term of terms.split("\n").map(item=>item.trim()).filter(Boolean)){
    result=result.split(term).join("[redacted]");
  }
  return result;
}
