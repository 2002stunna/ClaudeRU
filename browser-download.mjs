import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,basename,dirname} from 'node:path';

// Only a completed regular file in this operation's random download directory.
export async function readBrowserDownload(jobId,download,createdAt=Date.now()){
  const path=download?.path;
  if(!/^[a-f0-9]{32}$/.test(jobId)||typeof path!=='string'||!isAbsolute(path)||basename(dirname(path))!==jobId||basename(dirname(dirname(path)))!=='ClaudeRU')throw Error('Неверный каталог скачанного файла');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size<=0||stat.size>20*1024*1024||stat.mtimeMs<createdAt-5000||download.size!==stat.size)throw Error('Скачанный файл не готов или превышает 20 МБ');
    const bytes=await file.readFile();if(bytes.length!==stat.size)throw Error('Размер скачанного файла изменился');
    const name=basename(path),pdf=bytes.subarray(0,1024).includes(Buffer.from('%PDF-'));
    if(/\.pdf$/i.test(name)&&!pdf)throw Error('Вместо PDF браузер скачал страницу просмотра');
    return {name,type:pdf?'application/pdf':download.type||'application/octet-stream',data:bytes.toString('base64')};
  }finally{await file.close();}
}
