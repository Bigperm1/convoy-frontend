import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as Permissions from 'expo-permissions';

export async function requestLocationPermission() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted';
  } catch (e) {
    console.error('Location permission error:', e);
    return false;
  }
}

export async function requestNotificationPermission() {
  try {
    const { status } = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return status === 'granted';
  } catch (e) {
    console.error('Notification permission error:', e);
    return false;
  }
}

export async function requestMicrophonePermission() {
  try {
    const { status } = await Permissions.askAsync(Permissions.AUDIO);
    return status === 'granted';
  } catch (e) {
    console.error('Microphone permission error:', e);
    return false;
  }
}

export async function requestGaragePermissions() {
  const location = await requestLocationPermission();
  const notification = await requestNotificationPermission();
  return { location, notification };
}