import { invoke } from './runtime'

export type LinkDetails = {
  requestedUrl: string
  title: string | null
  description: string | null
}

export async function fetchLinkDetails(url: string): Promise<LinkDetails> {
  return invoke<LinkDetails>('fetch_link_details', { url })
}
