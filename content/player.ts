import { retry, throttle } from 'es-toolkit'
import { emit, log, isYTMusic, nouPolicy, parseJson } from './utils'
import { hideLiveChat, showLiveChatButton } from './livechat'
import { originalLabels } from './audio'
import { getSkipSegments, isSponsorBlockEnabled, Segment } from './sponsorblock'

export let player: any
let curVideoId = ''
let shouldSaveProgress = false
let restoredProgress = false
let skipSegments: { videoId: string; segments: Segment[] } = { videoId: '', segments: [] }

const keys = {
  playing: 'nou:playing',
  videos: 'nou:videos:progress',
  videoProgress(id: string) {
    return `nou:progress:${id}`
  },
}

export function handleMutations(mutations: MutationRecord[]) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes.values()) {
      const el = node as any
      if (el.id == 'movie_player') {
        handleVideoPlayer(el)
      }
    }
  }
}

let playbackRatesExtended = false
let settingsMenuObserver: MutationObserver | null = null

function extendPlaybackRates(player: any) {
  if (playbackRatesExtended) {
    return
  }
  
  try {
    // Extend available playback rates to include 2.5x, 3x, 3.5x, 4x
    const extendedRates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4]
    
    // Override the getAvailablePlaybackRates method
    const originalGetRates = player.getAvailablePlaybackRates?.bind(player)
    if (!originalGetRates) {
      log('Player getAvailablePlaybackRates method not available')
      return
    }
    
    player.getAvailablePlaybackRates = function() {
      return extendedRates
    }
    
    // Store original setPlaybackRate to allow any rate
    const originalSetRate = player.setPlaybackRate?.bind(player)
    if (!originalSetRate) {
      log('Player setPlaybackRate method not available')
      return
    }
    
    player.setPlaybackRate = function(rate: number) {
      // Get the video element from the player - YouTube player wraps a video element
      // Try multiple selectors in case YouTube changes their DOM structure
      const video = document.querySelector('#movie_player video') || 
                    player.querySelector?.('video') ||
                    document.querySelector('video')
      
      if (video && video instanceof HTMLVideoElement) {
        video.playbackRate = rate
      } else {
        log('Video element not found for playback rate change')
      }
      
      // Also call original method for rates <= 2 to maintain YouTube's internal state
      if (rate <= 2) {
        originalSetRate(rate)
      }
    }
    
    // Verify the overrides were successfully assigned
    if (player.getAvailablePlaybackRates && player.setPlaybackRate) {
      playbackRatesExtended = true
      log('Playback rates extended to 4x')
      
      // Set up observer to inject custom playback speed options into the settings menu
      setupPlaybackSpeedMenuObserver()
    }
  } catch (e) {
    log('Failed to extend playback rates:', e)
  }
}

function setupPlaybackSpeedMenuObserver() {
  // Clean up existing observer if any
  if (settingsMenuObserver) {
    settingsMenuObserver.disconnect()
  }
  
  // Observe a more specific container if possible, otherwise fall back to body
  const observeTarget = document.getElementById('movie_player') || document.body
  
  // Create observer to watch for settings menu
  settingsMenuObserver = new MutationObserver((mutations) => {
    // Only check when there are actual DOM changes
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        injectCustomPlaybackSpeeds()
      }
    }
  })
  
  // Observe the player container or body for settings menu appearing
  settingsMenuObserver.observe(observeTarget, {
    childList: true,
    subtree: true,
  })
}

function injectCustomPlaybackSpeeds() {
  try {
    // Look specifically for the playback rate panel, not just any menu
    // Use more specific selectors that only match playback speed menus
    const selectors = [
      'ytm-playback-rate-option-list',  // Mobile YouTube playback rate list
    ]
    
    let speedPanel: Element | null = null
    let foundSelector = ''
    for (const selector of selectors) {
      speedPanel = document.querySelector(selector)
      if (speedPanel) {
        foundSelector = selector
        break
      }
    }
    
    if (!speedPanel) {
      return
    }
    
    // Check if we already injected custom speeds
    if (speedPanel.querySelector('.nou-custom-speed')) {
      return
    }
    
    log(`Found speed panel with selector: ${foundSelector}`)
    
    // Try multiple selectors for speed options
    const optionSelectors = [
      'ytm-playback-rate-item',
      '.ytp-menuitem',
      '[role="menuitemradio"]',
    ]
    
    let existingOptions: NodeListOf<Element> | null = null
    let foundOptionSelector = ''
    for (const selector of optionSelectors) {
      existingOptions = speedPanel.querySelectorAll(selector)
      if (existingOptions.length > 0) {
        foundOptionSelector = selector
        break
      }
    }
    
    if (!existingOptions || existingOptions.length === 0) {
      log('No existing speed options found')
      return
    }
    
    // Validate that this is actually the playback rate menu by checking option content
    // Playback rate options should contain numeric values like "0.25", "0.5", "1", "1.25", etc.
    let isPlaybackRateMenu = false
    for (const option of Array.from(existingOptions)) {
      const text = option.textContent?.trim()
      // Check if text is a number (with or without 'x' suffix)
      if (text && /^(\d+(\.\d+)?)(x)?$/i.test(text)) {
        isPlaybackRateMenu = true
        break
      }
    }
    
    if (!isPlaybackRateMenu) {
      log('Not a playback rate menu, skipping injection')
      return
    }
    
    log(`Found ${existingOptions.length} existing options with selector: ${foundOptionSelector}`)
    
    // Get the last option as a template
    const templateOption = existingOptions[existingOptions.length - 1]
    if (!templateOption) {
      log('Template option is null')
      return
    }
    
    // Custom speeds to add (above 2x)
    const customSpeeds = [2.5, 3, 3.5, 4]
    
    // Create and inject custom speed options
    customSpeeds.forEach((speed) => {
      const customOption = templateOption.cloneNode(true) as HTMLElement
      customOption.classList.add('nou-custom-speed')
      
      // Update the speed value display - try multiple selectors
      const labelSelectors = ['.rate-label', '[class*="label"]', '.ytp-menuitem-label', 'span', 'div']
      let labelUpdated = false
      
      for (const selector of labelSelectors) {
        const label = customOption.querySelector(selector)
        if (label && label.textContent) {
          label.textContent = `${speed}`
          labelUpdated = true
          break
        }
      }
      
      // If no label found, try to update the entire element's text
      if (!labelUpdated && customOption.textContent) {
        customOption.textContent = `${speed}`
      }
      
      // Update any data attributes
      customOption.setAttribute('data-rate', speed.toString())
      
      // Add click handler
      customOption.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        
        if (!player) {
          log('Player not available for playback rate change')
          return
        }
        
        player.setPlaybackRate(speed)
        
        // Update UI to show selected state - clear all selections first
        existingOptions?.forEach((opt) => {
          opt.removeAttribute('checked')
          opt.removeAttribute('aria-checked')
          opt.classList.remove('ytp-menuitem-selected')
        })
        
        // Also update custom options
        speedPanel?.querySelectorAll('.nou-custom-speed').forEach((opt) => {
          opt.removeAttribute('checked')
          opt.removeAttribute('aria-checked')
          opt.classList.remove('ytp-menuitem-selected')
        })
        
        // Set this option as selected
        customOption.setAttribute('checked', '')
        customOption.setAttribute('aria-checked', 'true')
        customOption.classList.add('ytp-menuitem-selected')
        
        // Try to close the settings menu
        const closeSelectors = [
          'ytm-bottom-sheet-renderer .close-button',
          'button[aria-label*="lose"]',
          '.ytp-panel-back-button',
        ]
        
        for (const selector of closeSelectors) {
          const closeButton = document.querySelector(selector)
          if (closeButton instanceof HTMLElement) {
            closeButton.click()
            break
          }
        }
        
        log(`Playback speed set to ${speed}x`)
      })
      
      // Insert the custom option after existing options
      templateOption.parentNode?.appendChild(customOption)
    })
    
    log(`Injected ${customSpeeds.length} custom playback speeds into menu`)
  } catch (e) {
    log('Error injecting custom playback speeds:', e)
  }
}

export function handleVideoPlayer(el: any) {
  player = el
  
  // Extend playback rates to support up to 4x
  extendPlaybackRates(player)
  
  const saveProgress = throttle((currentTime) => {
    if (shouldSaveProgress && restoredProgress) {
      localStorage.setItem(keys.videoProgress(curVideoId), currentTime)
    }
    localStorage.setItem(keys.playing, JSON.stringify({ url: player.getVideoUrl() }))
  }, 5000)
  const notifyProgress = throttle(() => {
    if (!el.getCurrentTime) {
      hideLiveChat()
      return
    }
    const currentTime = el.getCurrentTime()
    window.NouTubeI?.notifyProgress(el.getPlayerState() == 1, currentTime)
    saveProgress(currentTime)
    if (isSponsorBlockEnabled() && curVideoId == skipSegments.videoId && skipSegments.segments.length) {
      for (const segment of skipSegments.segments) {
        const [start, end] = segment.segment
        if (currentTime > start && currentTime < end) {
          player.seekTo(end)
          return
        }
      }
    }
  }, 1000)
  let progressBinded = false
  el.addEventListener('onStateChange', async (state: number) => {
    const { playabilityStatus, videoDetails } = el.getPlayerResponse() || {}
    if (!videoDetails) {
      hideLiveChat()
      return
    }
    if (state == 0 && !isYTMusic) {
      emit('playback-end')
    }
    if (document.location.host == 'm.youtube.com' && document.location.pathname == '/') {
      el.pauseVideo()
      return
    }
    if (!progressBinded) {
      const video = el.querySelector('video')
      if (video) {
        ;['play', 'pause', 'timeupdate'].forEach((evt) => {
          video.addEventListener(evt, notifyProgress)
        })
        progressBinded = true
      }
    }

    const { title, author, thumbnail, lengthSeconds, videoId } = videoDetails
    if (curVideoId != videoId) {
      player.unMute()
      const thumb = thumbnail.thumbnails.at(-1)
      const duration = +lengthSeconds
      window.NouTubeI?.notify(title, author, duration, thumb?.url || '')
      curVideoId = videoId
      restoredProgress = false
      shouldSaveProgress = duration > 60 * 10
      if (shouldSaveProgress) {
        let lastProgress = Number(localStorage.getItem(keys.videoProgress(curVideoId)))
        if (lastProgress) {
          if (duration - lastProgress < 10 && lastProgress > 10) {
            lastProgress -= 10
          }
          player.seekTo(lastProgress)
        }
        restoredProgress = true
        if (shouldSaveProgress) {
          const watchProgress = parseJson(localStorage.getItem(keys.videos), [])
          watchProgress.push(curVideoId)
          if (watchProgress.length > 100) {
            const id = watchProgress.pop()
            localStorage.removeItem(keys.videoProgress(id))
          }
          localStorage.setItem(keys.videos, JSON.stringify(watchProgress))
        }
      }

      if (window.NouTubeI) {
        renderPlayOriginalAudioBtn()

        hideLiveChat()
        if (playabilityStatus?.liveStreamability) {
          showLiveChatButton(curVideoId)
        }
      }

      if (isSponsorBlockEnabled()) {
        skipSegments = await getSkipSegments(videoId)
      }
    }
  })
}

screen.orientation.addEventListener('change', (event) => {
  if (document.location.pathname != '/watch') {
    return
  }

  const target = event.target as any
  const type = target.type
  if (type.includes('landscape')) {
    if (!document.fullscreenElement && screen.availWidth < 1000) {
      ;(document.querySelector('#player-control-container .fullscreen-icon') as HTMLButtonElement)?.click()
    }
  } else {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    }
  }
})

export async function playDefaultAudio() {
  await retry(
    () => {
      if (!player) {
        throw 'player not ready'
      }
      return player
    },
    { retries: 30, delay: 100 },
  )
  player?.playVideo()
  const audioTracks: any[] = await retry(
    () => {
      const tracks = player.getAvailableAudioTracks()
      if (!tracks.length) {
        throw 'tracks not ready'
      }
      return tracks
    },
    { retries: 30, delay: 100 },
  )
  let options = ''
  let selected
  let i = 0
  for (const track of audioTracks) {
    for (let v of Object.values(track)) {
      const value = v as any
      if (value && typeof value == 'object' && 'isDefault' in value && value.name) {
        if (originalLabels.some((x) => value.name.includes(x))) {
          selected = i.toString()
          player.setAudioTrack(track)
        }
        options += `<option value="${i}">${value.name}</option>`
      }
    }
    i++
  }

  let container = document.querySelector('div#_inks_audio_picker')
  if (!container) {
    container = document.createElement('div')
    container.id = '_inks_audio_picker'
    document.body.append(container)
  }
  container.innerHTML = nouPolicy.createHTML(/* HTML */ `
    <select>
      ${options}
    </select>
  `)
  const select = container.querySelector('select')
  if (select) {
    if (selected) {
      select.value = selected
    }
    select.onchange = (e) => {
      const i = (e.target as HTMLSelectElement).value
      if (i != null) {
        player.setAudioTrack(audioTracks[+i])
      }
    }
  }
}

async function renderPlayOriginalAudioBtn() {
  if (document.location.pathname != '/watch' || isYTMusic) {
    return
  }

  const badgeRenderer = await retry(
    async () => {
      const badgeRenderer = document.querySelector('ytm-slim-video-information-renderer ytm-badge-supported-renderer')
      if (!badgeRenderer) {
        throw 'badge not ready'
      }
      return badgeRenderer
    },
    { retries: 30, delay: 100 },
  )

  if (!badgeRenderer) {
    return
  }

  const container = document.createElement('div')
  container.id = '_inks_audio_btn'
  container.innerHTML = nouPolicy.createHTML(/* HTML */ `
    Play original audio 🦦
  `)
  container.onclick = (e) => {
    e.stopPropagation()
    player.pauseVideo()
    emit('embed', curVideoId)
  }

  badgeRenderer.append(container)
}

export function restoreLastPlaying() {
  const value = parseJson(localStorage.getItem(keys.playing), {})
  if (value.url) {
    document.location = value.url
  }
}
