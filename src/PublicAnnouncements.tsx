import { ArrowRight } from 'lucide-react';

export type PublicAnnouncement = {
  id: string;
  kind: string;
  title: string;
  message: string;
  image_url: string | null;
  video_url?: string | null;
  button_text: string | null;
  button_link: string | null;
  tone: string;
  show_on?: string;
  priority?: number;
  starts_at?: string | null;
  ends_at?: string | null;
};

const rebrand = (value: string) => value.replace(/databundleshops(?:\.com)?/gi, 'CheapDataBundle');

export default function PublicAnnouncements({ updates, className = '' }: { updates: PublicAnnouncement[]; className?: string }) {
  if (!updates.length) return null;

  return <section className={`public-announcements ${className}`} aria-label="Public announcements">
    {updates.map(update => <article className={`shop-notice public-shop-update ${update.image_url||update.video_url ? 'announcement-with-image' : 'announcement-text-only'}`} key={update.id}>
      <span className="announcement-brandline">CheapDataBundle · Official Announcement</span>
      <div className="announcement-copy"><b>{rebrand(update.title)}</b><p>{rebrand(update.message)}</p></div>
      {update.image_url && <img className="public-shop-update-image" src={update.image_url} alt={rebrand(update.title)} loading="lazy"/>}
      {update.video_url && <video className="public-shop-update-image" controls playsInline preload="metadata" src={update.video_url}>{rebrand(update.title)}</video>}
      {update.button_text && update.button_link && <a className="public-update-cta" href={update.button_link} target={update.button_link.startsWith('http') ? '_blank' : undefined} rel={update.button_link.startsWith('http') ? 'noopener noreferrer' : undefined}>{update.button_text}<ArrowRight/></a>}
    </article>)}
  </section>;
}
