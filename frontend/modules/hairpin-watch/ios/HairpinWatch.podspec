Pod::Spec.new do |s|
  s.name           = 'HairpinWatch'
  s.version        = '1.0.0'
  s.summary        = 'Hairpin Apple Watch link (WatchConnectivity).'
  s.description    = 'Owns the phone side of WCSession: pushes drive/crew state to the watch, receives PTT clips.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WatchConnectivity'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
