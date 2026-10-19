// Answers recorded from a real speaker (Sonos/95.1, October 2026), with its address, ids and room name replaced.
// Literal text, so the parsers are tested on what a speaker sends, not on strings built by the code under test.

/** `GetZoneGroupState`: one speaker on its own, with the extra attributes firmware 95.1 sends. */
export const ZONE_GROUP_STATE =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<s:Body><u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">' +
  '<ZoneGroupState>&lt;ZoneGroupState&gt;&lt;ZoneGroups&gt;&lt;ZoneGroup' +
  ' Coordinator=&quot;RINCON_5CAAFD0A1B2C01400&quot; ID=&quot;RINCON_5CAAFD0A1B2C01400:1234567890&quot;&gt;' +
  '&lt;ZoneGroupMember UUID=&quot;RINCON_5CAAFD0A1B2C01400&quot;' +
  ' Location=&quot;http://192.168.1.20:1400/xml/device_description.xml&quot; ZoneName=&quot;Living Room&quot;' +
  ' Icon=&quot;&quot; Configuration=&quot;1&quot; SoftwareVersion=&quot;95.1-78010&quot; SWGen=&quot;2&quot;' +
  ' MinCompatibleVersion=&quot;94.0-00000&quot; LegacyCompatibleVersion=&quot;58.0-00000&quot;' +
  ' BootSeq=&quot;32&quot; TVConfigurationError=&quot;0&quot; HdmiCecAvailable=&quot;0&quot;' +
  ' WirelessMode=&quot;1&quot; ConnectionType=&quot;5&quot; ChannelFreq=&quot;5200&quot;' +
  ' BehindWifiExtender=&quot;0&quot; WifiEnabled=&quot;1&quot; EthLink=&quot;0&quot; Orientation=&quot;0&quot;' +
  ' RoomCalibrationState=&quot;1&quot; SecureRegState=&quot;3&quot; VoiceConfigState=&quot;0&quot;' +
  ' MicEnabled=&quot;0&quot; HeadphoneSwapActive=&quot;0&quot; AirPlayEnabled=&quot;1&quot;' +
  ' IdleState=&quot;1&quot; MoreInfo=&quot;TargetRoomName:Living Room&quot; SSLPort=&quot;1443&quot;' +
  ' HHSSLPort=&quot;1843&quot;/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;&lt;VanishedDevices&gt;' +
  '&lt;/VanishedDevices&gt;&lt;/ZoneGroupState&gt;</ZoneGroupState></u:GetZoneGroupStateResponse></s:Body>' +
  '</s:Envelope>';

/** `GetPositionInfo` while a Spotify artist radio plays a track. */
export const POSITION_INFO =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><Track>4</Track>' +
  '<TrackDuration>0:03:30</TrackDuration><TrackMetaData>' +
  '&lt;DIDL-Lite xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot; xmlns:r=&quot;urn:schemas-rinconnetworks-com:metadata-1-0/&quot;' +
  ' xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;&lt;item id=&quot;-1&quot;' +
  ' parentID=&quot;-1&quot; restricted=&quot;true&quot;&gt;&lt;res' +
  ' protocolInfo=&quot;sonos.com-spotify:*:audio/x-spotify:*&quot; duration=&quot;0:03:30&quot;&gt;' +
  'x-sonosprog-spotify:spotify%3atrack%3a2SiXAy7TuUkycRVbbWDEpo?sid=9&amp;amp;flags=8232&amp;amp;sn=2&lt;/res&gt;' +
  '&lt;r:streamContent&gt;&lt;/r:streamContent&gt;&lt;upnp:albumArtURI&gt;' +
  '/getaa?s=1&amp;amp;u=x-sonosprog-spotify%3aspotify%253atrack%253a2SiXAy7TuUkycRVbbWDEpo%3fsid%3d9%26flags%3d8232%26sn%3d2&lt;/upnp:albumArtURI&gt;' +
  '&lt;dc:title&gt;You Shook Me All Night Long&lt;/dc:title&gt;&lt;upnp:class&gt;' +
  'object.item.audioItem.musicTrack&lt;/upnp:class&gt;&lt;dc:creator&gt;AC/DC&lt;/dc:creator&gt;' +
  '&lt;upnp:album&gt;Back In Black&lt;/upnp:album&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</TrackMetaData><TrackURI>' +
  'x-sonosprog-spotify:spotify%3atrack%3a2SiXAy7TuUkycRVbbWDEpo?sid=9&amp;flags=8232&amp;sn=2</TrackURI><RelTime>' +
  '0:01:20</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>2147483647</RelCount><AbsCount>' +
  '2147483647</AbsCount></u:GetPositionInfoResponse></s:Body></s:Envelope>';

/** `GetTransportInfo` while playing. */
export const TRANSPORT_INFO =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<s:Body><u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
  '<CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>' +
  '<CurrentSpeed>1</CurrentSpeed></u:GetTransportInfoResponse></s:Body></s:Envelope>';

/** `GetCurrentTransportActions` on that Spotify artist radio: no `Previous`. */
export const TRANSPORT_ACTIONS =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<s:Body><u:GetCurrentTransportActionsResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><Actions>' +
  'Set, Stop, Pause, Play, Next</Actions></u:GetCurrentTransportActionsResponse></s:Body></s:Envelope>';

/** `GetGroupVolume`. */
export const GROUP_VOLUME =
  '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
  '<s:Body><u:GetGroupVolumeResponse xmlns:u="urn:schemas-upnp-org:service:GroupRenderingControl:1">' +
  '<CurrentVolume>32</CurrentVolume></u:GetGroupVolumeResponse></s:Body></s:Envelope>';
