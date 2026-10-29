import { ArrowRight, ShieldCheck } from 'lucide-react';

export type PublicAnnouncement = {
  id: string;
  kind: string;
  title: string;
  message: string;
  image_url: string | null;
  button_text: string | null;
  button_link: string | null;
  tone: string;
};

const rebrand = (value: string) => value.replace(/databundleshops(?:\.com)?/gi, 'DataShopGH');

export default function PublicAnnouncements({ updates, className = '' }: { updates: PublicAnnouncement[]; className?: string }) {
  if (!updates.length) return null;

  return <section className={`public-announcements ${className}`} aria-label="Public announcements">
    {updates.map(update => <article className={`shop-notice public-shop-update ${update.tone} ${update.image_url ? 'announcement-with-image' : 'announcement-text-only'}`} key={update.id}>
      <span className="notice-chip"><ShieldCheck/> DATASHOPGH · {update.image_url ? 'PUBLIC ADVERT' : 'PUBLIC ANNOUNCEMENT'}</span>
      {update.image_url && <img className="public-shop-update-image" src={update.image_url} alt={rebrand(update.title)} loading="lazy"/>}
      <div className="notice-copy"><b>{rebrand(update.title)}</b><small>{rebrand(update.message)}</small>{update.button_text && update.button_link && <a className="public-update-cta" href={update.button_link} target={update.button_link.startsWith('http') ? '_blank' : undefined} rel={update.button_link.startsWith('http') ? 'noopener noreferrer' : undefined}>{update.button_text}<ArrowRight/></a>}</div>
    </article>)}
  </section>;
}
