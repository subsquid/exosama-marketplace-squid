import https from 'https'
import assert from 'assert'
import { Store } from '@subsquid/typeorm-store'
import Axios from 'axios'
import { BlockHandlerContext } from '@subsquid/evm-processor'
import { BigNumber } from 'ethers'
import { Attribute, ERC721Contract, ERC721Token, Metadata } from '../model'
import { IRawMetadata } from '../types/custom/metadata'
import {
  EntitiesCache,
  EntityWithId,
  ERC721contracts,
  ERC721tokens,
  metadatas,
} from '../utils/entitiesManager'
import * as erc721 from '../abi/ExosamaCollection'
import { CONTRACT_API_BATCH_SIZE, IPFS_API_BATCH_SIZE } from '../utils/config'

export const BASE_URL = 'https://moonsama.mypinata.cloud/'

export const api = Axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
  timeout: 5000,
  httpsAgent: new https.Agent({ keepAlive: true }),
})

const urlBlackList = new Map<string, number>()
const BLACKLIST_TRIES_TRASHOLD = 5
const isUrlBanned = (url: string) => {
  const tries = urlBlackList.get(url)
  if (!tries) return false
  return tries > BLACKLIST_TRIES_TRASHOLD
}
const addFailedFetch = (url: string) => {
  let tries = urlBlackList.get(url)
  if (!tries) tries = 1
  else tries += 1
  urlBlackList.set(url, tries)
  return tries
}

export const sanitizeIpfsUrl = (ipfsUrl: string): string => {
  const reg1 = /^ipfs:\/\/ipfs/
  if (reg1.test(ipfsUrl)) {
    return ipfsUrl.replace('ipfs://', BASE_URL)
  }

  const reg2 = /^ipfs:\/\//
  if (reg2.test(ipfsUrl)) {
    return ipfsUrl.replace('ipfs://', `${BASE_URL}ipfs/`)
  }

  return ipfsUrl
}

export const fetchMetadata = async (
  ctx: BlockHandlerContext<Store>,
  url: string
): Promise<IRawMetadata | null> => {
  const properUrl = sanitizeIpfsUrl(url)
  if (isUrlBanned(properUrl)) {
    ctx.log.warn(`[IPFS] SKIP DUE TO TRIES LIMIT ${properUrl}`)
    return null
  }
  try {
    const { status, data } = await api.get(sanitizeIpfsUrl(properUrl))
    ctx.log.info(`[IPFS] ${status} ${properUrl}`)
    if (status < 400) {
      return data as IRawMetadata
    }
  } catch (e) {
    const tries = addFailedFetch(properUrl)
    ctx.log.warn(
      `[IPFS] ERROR ${properUrl} ${tries} TRY ${(e as Error).message}`
    )
  }
  return null
}

export async function parseMetadata(
  ctx: BlockHandlerContext<Store>,
  url: string,
  metaId: string
): Promise<Metadata | undefined> {
  const rawMeta = await fetchMetadata(ctx, url)
  if (!rawMeta) return undefined
  const metadata = new Metadata({
    id: metaId,
    name: rawMeta.name,
    description: rawMeta.description,
    image: rawMeta.image,
    externalUrl: rawMeta.external_url,
    layers: rawMeta.layers,
    artist: rawMeta.artist,
    artistUrl: rawMeta.artist_url,
    composite: Boolean(rawMeta.composite),
    type: rawMeta.type,
  })
  if (rawMeta.attributes) {
    const attributes: Attribute[] = rawMeta.attributes.map(
      (attr) =>
        new Attribute({
          displayType: attr.display_type
            ? String(attr.display_type)
            : attr.display_type,
          traitType: String(attr.trait_type),
          value: String(attr.value),
        })
    )
    metadata.attributes = attributes
  }
  // ctx.log.info(attributes)
  // ctx.log.info(metadata)
  return metadata
}

interface ContractMetadata {
  name: string
  description: string
  image: string
  externalLink: string
  artist?: string
  artistUrl?: string
}

export const fetchContractMetadata = async (
  ctx: BlockHandlerContext<Store>,
  url: string
): Promise<ContractMetadata | undefined> => {
  const properUrl = sanitizeIpfsUrl(url)
  if (isUrlBanned(properUrl)) {
    ctx.log.warn(`[IPFS] SKIP DUE TO TRIES LIMIT ${properUrl}`)
    return undefined
  }
  try {
    const { status, data } = await api.get(sanitizeIpfsUrl(properUrl))
    ctx.log.info(`[IPFS] ${status} ${properUrl}`)
    if (status < 400) {
      return {
        name: data.name,
        description: data.description,
        image: data.image,
        externalLink: data.external_link,
        artist: data.artist,
        artistUrl: data.artist_url,
      }
    }
  } catch (e) {
    const tries = addFailedFetch(properUrl)
    ctx.log.warn(
      `[IPFS] ERROR ${properUrl} ${tries} TRY ${(e as Error).message}`
    )
  }
  return undefined
}

export async function batchEntityMapper<T extends EntityWithId>(
  ctx: BlockHandlerContext<Store>,
  manager: EntitiesCache<T>,
  buffer_: Array<T>,
  updater: (
    ctx: BlockHandlerContext<Store>,
    entity: T,
    manager: EntitiesCache<T>
  ) => Promise<void>,
  batchSize: number
): Promise<void> {
  for (let i = 0; i < buffer_.length; i += batchSize) {
    await Promise.all(
      buffer_.slice(i, i + batchSize).map(async (entity) => {
        await updater(ctx, entity, manager)
      })
    )
  }
}

async function get721ContractUri(
  ctx: BlockHandlerContext<Store>,
  entity: ERC721Contract,
  manager: EntitiesCache<ERC721Contract>
): Promise<void> {
  const contractAPI = new erc721.Contract(ctx, entity.id)
  let contractURI
  try {
    contractURI = await contractAPI.contractURI()
    ctx.log.info(`[API] Fetched contractURI of ${entity.id}`)
  } catch {
    ctx.log.warn(`[API] Error during fetch contractURI of ${entity.id}`)
    return
  }
  if (contractURI !== entity.contractURI || manager.hasToUpdate(entity)) {
    entity.contractURI = contractURI
    entity.contractURIUpdated = BigInt(ctx.block.timestamp) / BigInt(1000)
  }
}

async function get721TokenUri(
  ctx: BlockHandlerContext<Store>,
  entity: ERC721Token,
  manager: EntitiesCache<ERC721Token>
): Promise<void> {
  const contractAPI = new erc721.Contract(ctx, entity.contract.id)
  let tokenURI
  try {
    tokenURI = await contractAPI.tokenURI(BigNumber.from(entity.numericId))
    ctx.log.info(`[API] Fetched tokenURI of ${entity.id}`)
  } catch (err) {
    ctx.log.warn(`[API] Error during fetch tokenURI of ${entity.id}\n${err}`)
    return
  }
  if (
    !entity.metadataId ||
    tokenURI !== entity.tokenUri ||
    manager.hasToUpdate(entity)
  ) {
    entity.tokenUri = tokenURI
    entity.updatedAt = BigInt(ctx.block.timestamp) / BigInt(1000)
  }
}

async function fillTokenMetadata<T extends ERC721Token>(
  ctx: BlockHandlerContext<Store>,
  entity: T,
  manager: EntitiesCache<T>
): Promise<void> {
  if (!entity.tokenUri) {
    return ctx.log.warn(
      `Tried to update metadata of ${entity.id} with null tokenURI`
    )
  }
  const meta = await parseMetadata(ctx, entity.tokenUri, entity.id)
  if (meta) {
    metadatas.save(meta)
    entity.metadata = meta
    manager.save(entity)
    manager.delFromUriUpdatedBuffer(entity)
    ctx.log.info(`Metadata updated for token - ${entity.id}`)
  }
}
async function fillContractMetadata<T extends ERC721Contract>(
  ctx: BlockHandlerContext<Store>,
  entity: T,
  manager: EntitiesCache<T>
): Promise<void> {
  if (!entity.contractURI) {
    return ctx.log.warn(
      `Tried to update metadata of ${entity.id} with null contractURI`
    )
  }
  const rawMetadata = await fetchContractMetadata(ctx, entity.contractURI)
  if (rawMetadata) {
    entity.metadataName = rawMetadata.name
    entity.artist = rawMetadata.artist
    entity.artistUrl = rawMetadata.artistUrl
    entity.externalLink = rawMetadata.externalLink
    entity.description = rawMetadata.description
    entity.image = rawMetadata.image
    manager.save(entity)
    manager.delFromUriUpdatedBuffer(entity)
    ctx.log.info(`Metadata updated for contract - ${entity.id}`)
  }
}

function updateFailedEntity(
  ctx: BlockHandlerContext<Store>,
  manager: EntitiesCache<EntityWithId>
) {
  manager.getBuffer().forEach((entity) => {
    if (manager.hasToUpdate(entity)) manager.addToUriUpdatedBuffer(entity)
  })
}

export async function updateAllMetadata(
  ctx: BlockHandlerContext<Store>
): Promise<void> {
  updateFailedEntity(ctx, ERC721contracts)
  updateFailedEntity(ctx, ERC721tokens)

  await batchEntityMapper(
    ctx,
    ERC721contracts,
    ERC721contracts.getUriUpdateBuffer(),
    get721ContractUri,
    CONTRACT_API_BATCH_SIZE
  )
  await Promise.all([
    batchEntityMapper(
      ctx,
      ERC721contracts,
      ERC721contracts.getUriUpdateBuffer(),
      fillContractMetadata,
      IPFS_API_BATCH_SIZE
    ),
    batchEntityMapper(
      ctx,
      ERC721tokens,
      ERC721tokens.getUriUpdateBuffer(),
      get721TokenUri,
      CONTRACT_API_BATCH_SIZE
    ),
  ])

  await batchEntityMapper(
    ctx,
    ERC721tokens,
    ERC721tokens.getUriUpdateBuffer(),
    fillTokenMetadata,
    IPFS_API_BATCH_SIZE
  )
}
