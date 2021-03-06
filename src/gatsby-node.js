import path from 'path'
import url from 'url'
import fs from 'fs-extra'
import _ from 'lodash'

import defaultOptions from './defaults'
import Manager from './SiteMapManager'

const PUBLICPATH = `./public`
const INDEXFILE = `/sitemap.xml`
const RESOURCESFILE = `/sitemap-:resource.xml`
const XSLFILE = path.resolve(__dirname, `./static/sitemap.xsl`)
const DEFAULTQUERY = `{
  allSitePage {
    edges {
      node {
        id
        slug: path
        url: path
      }
    }
  }
  site {
    siteMetadata {
      siteUrl
    }
  }
}`
const DEFAULTMAPPING = {
    allSitePage: {
        sitemap: `pages`,
    },
}
let siteUrl

const copyStylesheet = async ({ siteUrl, indexOutput }) => {
    const siteRegex = /(\{\{blog-url\}\})/g

    // Get our stylesheet template
    const data = await fs.readFile(XSLFILE)

    // Replace the `{{blog-url}}` variable with our real site URL
    const sitemapStylesheet = data.toString().replace(siteRegex, url.resolve(siteUrl, indexOutput))

    // Save the updated stylesheet to the public folder, so it will be
    // available for the xml sitemap files
    await fs.writeFile(path.join(PUBLICPATH, `sitemap.xsl`), sitemapStylesheet)
}

const serializeMarkdownNodes = (node) => {
    if (!node.fields.slug) {
        throw Error(`\`slug\` is a required field`)
    }

    node.slug = node.fields.slug

    delete node.fields.slug

    if (node.frontmatter) {
        if (node.frontmatter.published_at) {
            node.published_at = node.frontmatter.published_at
            delete node.frontmatter.published_at
        }
        if (node.frontmatter.feature_image) {
            node.feature_image = node.frontmatter.feature_image
            delete node.frontmatter.feature_image
        }
    }

    return node
}

const getNodePath = (node, allSitePage, pathPrefix) => {
    if (!node.slug) {
        return node
    }
    const slugRegex = new RegExp(`${node.slug.replace(/\/$/, ``)}$`, `gi`)

    node.path = path.join(pathPrefix, node.slug)

    for (let page of allSitePage.edges) {
        if (page.node && page.node.url && page.node.url.replace(/\/$/, ``).match(slugRegex)) {
            node.path = page.node.url
            break
        }
    }

    return node
}

// Add all other URLs that Gatsby generated, using siteAllPage,
// but we didn't fetch with our queries
const addPageNodes = (parsedNodesArray, allSiteNodes, siteUrl) => {
    const [parsedNodes] = parsedNodesArray
    const pageNodes = []
    const addedPageNodes = { pages: [] }

    const usedNodes = allSiteNodes.filter(({ node }) => {
        let foundOne
        for (let type in parsedNodes) {
            parsedNodes[type].forEach(((fetchedNode) => {
                if (node.url === fetchedNode.node.path) {
                    foundOne = true
                }
            }))
        }
        return foundOne
    })

    const remainingNodes = _.difference(allSiteNodes, usedNodes)

    remainingNodes.forEach(({ node }) => {
        addedPageNodes.pages.push({
            url: url.resolve(siteUrl, node.url),
            node: node,
        })
    })

    pageNodes.push(addedPageNodes)

    return pageNodes
}

const serializeSources = (mapping) => {
    let sitemaps = []

    for (let resourceType in mapping) {
        sitemaps.push(mapping[resourceType])
    }

    sitemaps = _.map(sitemaps, (source) => {
        // Ignore the key and only return the name and
        // source as we need those to create the index
        // and the belonging sources accordingly
        return {
            name: source.name ? source.name : source.sitemap,
            sitemap: source.sitemap,
        }
    })

    sitemaps = _.uniqBy(sitemaps, `name`)

    return sitemaps
}

const runQuery = (handler, { query, exclude }) => handler(query).then((r) => {
    if (r.errors) {
        throw new Error(r.errors.join(`, `))
    }

    for (let source in r.data) {
        // Removing excluded paths
        if (r.data[source] && r.data[source].edges && r.data[source].edges.length) {
            r.data[source].edges = r.data[source].edges.filter(({ node }) => !exclude.some((excludedRoute) => {
                const slug = source === `allMarkdownRemark` ? node.fields.slug.replace(/^\/|\/$/, ``) : node.slug.replace(/^\/|\/$/, ``)
                excludedRoute = excludedRoute.replace(/^\/|\/$/, ``)

                return slug.indexOf(excludedRoute) >= 0
            }))
        }
    }

    return r.data
})

const serialize = ({ ...sources } = {},{ site, allSitePage }, mapping, pathPrefix) => {
    const nodes = []
    const sourceObject = {}

    siteUrl = site.siteMetadata.siteUrl

    for (let type in sources) {
        if (mapping[type] && mapping[type].sitemap) {
            const currentSource = sources.hasOwnProperty(type) ? sources[type] : []

            if (currentSource) {
                sourceObject[mapping[type].sitemap] = sourceObject[mapping[type].sitemap] || []
                currentSource.edges.map(({ node }) => {
                    if (!node) {
                        return
                    }

                    if (type === `allMarkdownRemark`) {
                        node = serializeMarkdownNodes(node)
                    }

                    // get the real path for the node, which is generated by Gatsby
                    node = getNodePath(node, allSitePage, pathPrefix)

                    sourceObject[mapping[type].sitemap].push({
                        url: url.resolve(siteUrl, node.path),
                        node: node,
                    })
                })
            }
        }
    }
    nodes.push(sourceObject)

    const pageNodes = addPageNodes(nodes, allSitePage.edges, siteUrl)

    const allNodes = _.merge(nodes, pageNodes)

    return allNodes
}

export const onPostBuild = async ({ graphql, pathPrefix }, pluginOptions) => {
    let queryRecords
    const options = Object.assign(defaultOptions, options, pluginOptions)
    const { mapping } = options
    const indexSitemapFile = path.join(PUBLICPATH, INDEXFILE)
    const resourcesSitemapFile = path.join(PUBLICPATH, RESOURCESFILE)

    delete options.plugins
    delete options.createLinkInHead

    options.indexOutput = INDEXFILE
    options.resourcesOutput = RESOURCESFILE

    // We always query siteAllPage as well as the site query to
    // get data we need and to also allow not passing any custom
    // query or mapping
    const defaultQueryRecords = await runQuery(
        graphql,
        { query: DEFAULTQUERY, exclude: options.exclude }
    )

    // Don't run this query when no query and mapping is passed
    if (!options.query || !options.mapping) {
        options.mapping = options.mapping || DEFAULTMAPPING
    } else {
        queryRecords = await runQuery(graphql, options)
    }

    // Instanciate the Ghost Sitemaps Manager
    const manager = new Manager(options)

    serialize(queryRecords, defaultQueryRecords, mapping, pathPrefix).forEach((source) => {
        for (let type in source) {
            source[type].forEach((node) => {
                // "feed" the sitemaps manager with our serialized records
                manager.addUrls(type, node)
            })
        }
    })

    // The siteUrl is only available after we have the returned query results
    options.siteUrl = siteUrl

    await copyStylesheet(options)

    const resourcesSiteMapsArray = []

    // Because it's possible to map duplicate names and/or sources to different
    // sources, we need to serialize it in a way that we know which source names
    // we need and which types they are assignes to, independently from where they
    // come from
    options.sources = serializeSources(mapping)

    options.sources.forEach((type) => {
        // for each passed name we want to receive the related source type
        resourcesSiteMapsArray.push({
            type: type.name,
            xml: manager.getSiteMapXml(type.sitemap, options),
        })
    })

    const indexSiteMap = manager.getIndexXml(options)

    // Save the generated xml files in the public folder
    try {
        await fs.writeFile(indexSitemapFile, indexSiteMap)

        resourcesSiteMapsArray.forEach(async (sitemap) => {
            const filePath = resourcesSitemapFile.replace(/:resource/, sitemap.type)
            await fs.writeFile(filePath, sitemap.xml)
        })
    } catch (err) {
        console.error(err)
    }

    return
}
