import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BookOpen, Video } from 'lucide-react';

type HelpItem = { id:string; kind:'article'|'video'; title:string; message:string; video_url:string|null };

export default function InfoLibrary({client}:{client:SupabaseClient|null}){
 const [items,setItems]=useState<HelpItem[]>([]);
 useEffect(()=>{let live=true;if(!client){setItems([]);return}void client.from('public_help_items').select('id,kind,title,message,video_url').eq('is_active',true).order('priority',{ascending:false}).order('created_at',{ascending:false}).then(({data})=>{if(live&&data)setItems(data as HelpItem[])});return()=>{live=false}},[client]);
 return <>
  <div className="shortcode-list"><article className="shortcode-card mtn"><div><h2>MTN data bundles</h2><p>Dial the MTN data menu to browse bundle options.</p><b>*138#</b></div></article><article className="shortcode-card bigtime"><div><h2>Tigo Big Time (AT)</h2><p>Dial the AT menu, then choose option 1 for BigTime data.</p><b>*111# → Option 1</b></div></article><article className="shortcode-card telecel"><div><h2>Telecel bundles</h2><p>Open the Telecel USSD menu and choose the bundle you need.</p><b>*700#</b></div></article></div>
  <p className="shortcode-note">USSD menus and options can change. Follow the instructions shown on your phone.</p>
  {items.length>0&&<section className="help-library"><div className="help-library-heading"><BookOpen/><div><h2>Guides &amp; video tutorials</h2><p>Instructions and walkthroughs from DataShopGH.</p></div></div><div className="help-library-list">{items.map(item=><article className="help-library-item" key={item.id}>{item.kind==='video'&&item.video_url?<video controls preload="metadata" playsInline src={item.video_url}>{item.title}</video>:<span className="help-library-icon"><BookOpen/></span>}<div><span className="help-item-kind">{item.kind==='video'?<><Video size={14}/> VIDEO TUTORIAL</>:'WRITTEN GUIDE'}</span><h3>{item.title}</h3><p>{item.message}</p></div></article>)}</div></section>}
 </>;
}
