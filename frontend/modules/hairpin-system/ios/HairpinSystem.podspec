Pod::Spec.new do |s|
  s.name           = 'HairpinSystem'
  s.version        = '1.0.0'
  s.summary        = 'Hairpin system integrations: visit monitoring + widget shared defaults.'
  s.description    = 'CLVisit visit monitoring (arrival detection) and App Group shared defaults for the Hairpin widget.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
