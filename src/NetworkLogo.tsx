import type { CSSProperties } from 'react';
import atLogo from './assets/at-network.jpeg';
import mtnLogo from './assets/mtn-network.jpeg';
import telecelLogo from './assets/telecel-network.jpeg';
import airtelTigoIshareLogo from './assets/airteltigo-ishare.png';

export type DataNetwork = 'AT' | 'MTN' | 'Telecel';

const logos: Record<DataNetwork, string> = { AT: atLogo, MTN: mtnLogo, Telecel: telecelLogo };
const colors: Record<DataNetwork, string> = { AT: '#243f78', MTN: '#ffcb05', Telecel: '#ed1c2e' };

export default function NetworkLogo({ network, className = '', isIshare = false }: { network: DataNetwork; className?: string; isIshare?: boolean }) {
  const logo = network === 'AT' && isIshare ? airtelTigoIshareLogo : logos[network];
  return <span className={`network-logo ${network.toLowerCase()} ${isIshare ? 'ishare-logo' : ''} ${className}`.trim()} style={{ '--network-brand-color': colors[network] } as CSSProperties} aria-label={isIshare ? 'AirtelTigo iShare logo' : `${network} logo`}><img src={logo} alt="" /></span>;
}
